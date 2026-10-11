"""Live three-way comparison: index the same chunks three ways and time each one.

  single   Cassandra's built-in vector search used the usual way: one embedding per chunk in a
           vector column with a SAI index.
  live     The ColBERT Live! design (DataStax): ColBERT token vectors pooled by 2, every vector a
           row in a table with a SAI index. Our re-implementation of the published design.
  smdb     This index: token vectors pooled, compressed to PQ codes, plain tables.

Each system really encodes the chunks and really writes them to Cassandra; the numbers are wall
clock time and bytes handed to the database for THIS document on THIS machine. The systems run
one after another (not in parallel) so they do not compete for the CPU, and the job reports
progress while it runs.

"Bytes" is the data written (vectors or codes plus keys), before the database adds its own
overhead; a per-document on-disk size cannot be read back from Cassandra while it is running.
For on-disk sizes after compaction see the book benchmark (scripts/eval_book.py --cassandra).

SAI needs Cassandra 5.0, so the comparison writes to its own Cassandra (SMDB_COMPARE_PORT,
default 9044 = the cassandra-jdk21 container), never to the application's keyspace.

After the three indexes are built they stay alive so their QUALITY can be compared too:
  search(job, question)       the top passages each system returns for one question
  selftest(job, items)        known-item test: each item is a question written for one chunk;
                              a system scores when it returns that chunk (first / in the top 5)
The data is removed when the job is closed (close) or when the next comparison starts.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass, field

import numpy as np

from .index import Index
from .pooling import pool_hierarchical

N_ANN = 171          # ColBERT Live! defaults for k = 10: ANN results per query vector ...
N_MAXSIM = 20        # ... and chunks whose full vectors are fetched for exact MaxSim

BATCH = 16
SYSTEMS = [
    ("single", "Cassandra vector search", "one embedding per chunk, built-in vector index (SAI)"),
    ("live", "ColBERT Live! design", "full token vectors pooled by 2, each in the vector index (SAI)"),
    ("smdb", "StudyMate index", "pooled token vectors compressed to 32-byte codes, plain tables"),
]


@dataclass
class SystemRun:
    id: str
    name: str
    how: str
    state: str = "pending"          # pending | running | done | failed
    done: int = 0
    total: int = 0
    encode_s: float = 0.0
    write_s: float = 0.0
    vectors: int = 0                # rows of vector / code data written
    bytes: int = 0
    error: str | None = None

    def view(self) -> dict:
        secs = self.encode_s + self.write_s
        return {
            "id": self.id, "name": self.name, "how": self.how, "state": self.state,
            "done": self.done, "total": self.total,
            "encode_s": round(self.encode_s, 3), "write_s": round(self.write_s, 3),
            "seconds": round(secs, 3),
            "chunks_per_s": round(self.done / secs, 2) if secs > 0 and self.done else None,
            "write_chunks_per_s": round(self.done / self.write_s, 2) if self.write_s > 0 and self.done else None,
            "vectors": self.vectors, "bytes": self.bytes,
            "bytes_per_chunk": round(self.bytes / self.done) if self.done else None,
            "error": self.error,
        }


@dataclass
class Job:
    id: str
    total: int
    truncated_from: int | None
    state: str = "running"          # running | done | failed
    error: str | None = None
    systems: list[SystemRun] = field(default_factory=list)
    started: float = field(default_factory=time.time)
    texts: list[str] = field(default_factory=list, repr=False)
    sink: object = field(default=None, repr=False)
    index: object = field(default=None, repr=False)
    lock: object = field(default=None, repr=False)
    dims: dict = field(default_factory=dict, repr=False)
    closed: bool = False
    cancel: bool = False               # set to stop a running job at the next batch

    def view(self) -> dict:
        return {"job_id": self.id, "state": self.state, "error": self.error, "total": self.total,
                "truncated_from": self.truncated_from, "store": _store_kind(),
                "searchable": self.state == "done" and not self.closed,
                "systems": [s.view() for s in self.systems]}


_jobs: dict[str, Job] = {}
_single = {}                         # lazily loaded single-vector model


def _store_kind() -> str:
    return os.getenv("SMDB_COMPARE_STORE", "cassandra").lower()


def _single_encoder(index: Index):
    """Text -> one unit vector per chunk."""
    if type(index.encoder).__name__ == "HashEncoder":          # wiring tests: no model download
        def enc(texts):
            out = []
            for t in texts:
                v = index.encoder.encode_doc(t)
                m = v.mean(axis=0) if len(v) else np.zeros(index.encoder.dim, dtype=np.float32)
                out.append(m / (np.linalg.norm(m) + 1e-9))
            return np.stack(out).astype(np.float32)
        return enc
    if "model" not in _single:
        from sentence_transformers import SentenceTransformer
        _single["model"] = SentenceTransformer(
            os.getenv("SMDB_SINGLE_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
            device=os.getenv("SMDB_DEVICE", "cpu"))
    model = _single["model"]
    return lambda texts: np.asarray(model.encode(texts, batch_size=BATCH, normalize_embeddings=True,
                                                 show_progress_bar=False), dtype=np.float32)


class _Sink:
    """Where the comparison writes. Cassandra 5.0 for real runs; a no-op sink for wiring tests."""

    def __init__(self, index: Index) -> None:
        self.kind = _store_kind()
        self.index = index
        self.session = None
        self._prepared: dict[str, object] = {}
        self.mem: dict[str, list] = {"sv": [], "cl": []}     # memory sink: (job, chunk, vector)
        if self.kind == "memory":
            from .store import MemoryStore
            self.smdb = Index(MemoryStore(), index.q, pool=index.pool)
            return
        from cassandra.cluster import Cluster
        from .store import CassandraStore
        hosts = os.getenv("SMDB_COMPARE_HOSTS", "127.0.0.1").split(",")
        port = int(os.getenv("SMDB_COMPARE_PORT", "9044"))
        self.cluster = Cluster(hosts, port=port, protocol_version=4)
        self.session = self.cluster.connect()
        self.session.default_timeout = 60
        version = self.session.execute("SELECT release_version FROM system.local").one()[0]
        if int(version.split(".")[0]) < 5:
            raise RuntimeError(f"the comparison needs Cassandra 5.0+ for SAI vector indexes; "
                               f"{hosts[0]}:{port} runs {version}")
        self.ks = "smdb_compare"
        rf = int(os.getenv("SMDB_RF", "1"))
        self.session.execute(f"CREATE KEYSPACE IF NOT EXISTS {self.ks} WITH replication = "
                             f"{{'class': 'SimpleStrategy', 'replication_factor': {rf}}}")
        self.smdb = Index(CassandraStore(contact_points=hosts, port=port, keyspace="smdb_compare_idx",
                                         replication_factor=rf),
                          index.q, pool=index.pool)

    def _table(self, name: str, dim: int, multi: bool) -> str:
        table = f"{self.ks}.{name}_{dim}"
        if table not in self._prepared:
            key = "PRIMARY KEY ((job, chunk_id), embedding_id)" if multi else "PRIMARY KEY ((job, chunk_id))"
            extra = "embedding_id int, " if multi else ""
            self.session.execute(f"CREATE TABLE IF NOT EXISTS {table} (job text, chunk_id int, {extra}"
                                 f"v vector<float, {dim}>, {key})")
            self.session.execute(f"CREATE CUSTOM INDEX IF NOT EXISTS ON {table}(v) USING 'StorageAttachedIndex' "
                                 "WITH OPTIONS = {'similarity_function': 'dot_product'}")
            cols = "job, chunk_id, embedding_id, v" if multi else "job, chunk_id, v"
            marks = "?, ?, ?, ?" if multi else "?, ?, ?"
            self._prepared[table] = self.session.prepare(f"INSERT INTO {table} ({cols}) VALUES ({marks})")
            self._prepared[table + ":del"] = self.session.prepare(
                f"DELETE FROM {table} WHERE job = ? AND chunk_id = ?")
            self._prepared[table + ":ann"] = self.session.prepare(
                f"SELECT job, chunk_id, similarity_dot_product(v, ?) AS s FROM {table} ORDER BY v ANN OF ? LIMIT ?")
            self._prepared[table + ":get"] = self.session.prepare(
                f"SELECT v FROM {table} WHERE job = ? AND chunk_id = ?")
        return table

    def ann(self, name: str, dim: int, multi: bool, job_id: str, queries: np.ndarray, limit: int):
        """Nearest stored vectors for each query vector: list (one per query) of (chunk, similarity).
        Rows of other jobs are filtered out (they only exist while an older job is being removed)."""
        if self.kind == "memory":
            rows = [(c, v) for j, c, v in self.mem[name] if j == job_id]
            if not rows:
                return [[] for _ in queries]
            mat = np.stack([v for _, v in rows])
            out = []
            for q in queries:
                sim = mat @ q
                top = np.argsort(-sim)[:limit]
                out.append([(rows[i][0], float(sim[i])) for i in top])
            return out
        from cassandra.concurrent import execute_concurrent_with_args
        stmt = self._prepared[self._table(name, dim, multi) + ":ann"]
        res = execute_concurrent_with_args(self.session, stmt,
                                           [(q.tolist(), q.tolist(), limit) for q in queries], concurrency=8)
        return [[(r.chunk_id, r.s) for r in rs.result_or_exc if r.job == job_id] for rs in res]

    def fetch(self, name: str, dim: int, job_id: str, chunks: list[int]) -> list[np.ndarray]:
        """All vectors of each given chunk (ColBERT Live! second stage)."""
        if self.kind == "memory":
            return [np.stack([v for j, c, v in self.mem[name] if j == job_id and c == ch]) for ch in chunks]
        from cassandra.concurrent import execute_concurrent_with_args
        stmt = self._prepared[self._table(name, dim, True) + ":get"]
        res = execute_concurrent_with_args(self.session, stmt, [(job_id, c) for c in chunks], concurrency=16)
        return [np.array([r.v for r in rs.result_or_exc], dtype=np.float32) for rs in res]

    def write_vectors(self, name: str, dim: int, multi: bool, rows: list[tuple]) -> None:
        if self.kind == "memory":
            self.mem[name].extend((r[0], r[1], np.asarray(r[-1], dtype=np.float32)) for r in rows)
            return
        from cassandra.concurrent import execute_concurrent_with_args
        stmt = self._prepared[self._table(name, dim, multi)]
        conc = 8                         # SAI's graph builder rejects more than ~13 concurrent writes
        for attempt in range(6):
            res = execute_concurrent_with_args(self.session, stmt, rows, concurrency=conc,
                                               raise_on_first_error=False)
            rows = [r for r, (ok, _) in zip(rows, res) if not ok]
            if not rows:
                return
            conc = max(1, conc // 2)
            time.sleep(0.5 + attempt)
        raise RuntimeError("vector inserts keep failing; see the Cassandra log")

    def cleanup(self, job: Job, dims: dict[str, tuple[int, bool]]) -> None:
        try:
            if self.kind == "memory":
                self.mem = {"sv": [], "cl": []}
            else:
                from cassandra.concurrent import execute_concurrent_with_args
                for name, (dim, multi) in dims.items():
                    stmt = self._prepared.get(self._table(name, dim, multi) + ":del")
                    execute_concurrent_with_args(self.session, stmt, [(job.id, d) for d in range(job.total)],
                                                 concurrency=16, raise_on_first_error=False)
            for d in range(job.total):
                self.smdb.delete(f"cmp:{job.id}", str(d))
        finally:
            if self.kind != "memory":
                self.smdb.store.close()
                self.cluster.shutdown()


def start(index: Index, texts: list[str], lock: threading.Lock, max_chunks: int = 300) -> Job:
    """Start a comparison in a background thread and return its job (poll `get`)."""
    texts = [t for t in texts if t and t.strip()]
    if not texts:
        raise ValueError("no chunks to compare")
    truncated = len(texts) if len(texts) > max_chunks else None
    texts = texts[:max_chunks]
    job = Job(uuid.uuid4().hex[:12], len(texts), truncated)
    job.systems = [SystemRun(i, n, h, total=len(texts)) for i, n, h in SYSTEMS]
    sink = _Sink(index)                 # connect first: a missing Cassandra 5 fails the request, not the thread
    for old in list(_jobs.values()):    # one live comparison at a time: its rows must not mix with ours
        close(old.id, wait_vectors=True)
    job.texts, job.sink, job.index, job.lock = texts, sink, index, lock
    _jobs[job.id] = job
    if len(_jobs) > 50:
        for old in sorted(_jobs.values(), key=lambda j: j.started)[:-50]:
            _jobs.pop(old.id, None)
    threading.Thread(target=_run, args=(job, index, texts, lock, sink), daemon=True).start()
    return job


def close(job_id: str, wait_vectors: bool = False) -> bool:
    """Remove a finished comparison's data. Safe to call twice."""
    job = _jobs.get(job_id)
    if job is None or job.closed:
        return False
    if job.state == "running":          # stop it; its own thread removes what it wrote
        job.cancel = True
        if wait_vectors:
            for _ in range(200):
                if job.state != "running":
                    break
                time.sleep(0.1)
        return True
    job.closed = True
    sink, job.sink = job.sink, None
    if sink is None:
        return False
    t = threading.Thread(target=_safe_cleanup, args=(sink, job), daemon=True)
    t.start()
    if wait_vectors:
        t.join(timeout=20)              # vector rows go first and fast; the rest may finish later
    return True


def _safe_cleanup(sink, job) -> None:
    try:
        sink.cleanup(job, job.dims)
    except Exception:
        pass


def _live(job_id: str) -> Job:
    job = _jobs.get(job_id)
    if job is None:
        raise KeyError("unknown comparison job")
    if job.state != "done" or job.closed or job.sink is None:
        raise RuntimeError("this comparison is not searchable (still running, failed, or already closed)")
    return job


def _preview(text: str, n: int = 240) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[:n].rstrip() + "..."


def _search_all(job: Job, question: str, k: int) -> list[dict]:
    """Run one question through the three indexes of a job. Each: ranked chunk numbers + time."""
    index, sink = job.index, job.sink
    out = []

    # one embedding per chunk
    t = time.perf_counter()
    with job.lock:
        qe = _single_encoder(index)([question])[0]
    dim, _ = job.dims["sv"]
    hits = sink.ann("sv", dim, False, job.id, qe[None, :], k)[0]
    out.append({"id": "single", "chunks": [c for c, _ in hits][:k], "ms": (time.perf_counter() - t) * 1e3})

    # ColBERT Live! design: ANN per query vector, then exact MaxSim on the best chunks
    t = time.perf_counter()
    with job.lock:
        qv = np.asarray(index.encoder.encode_query(question), dtype=np.float32)
    dim, _ = job.dims["cl"]
    score: dict[int, float] = {}
    for per_q in sink.ann("cl", dim, True, job.id, qv, N_ANN):
        best: dict[int, float] = {}
        for c, sim in per_q:
            if sim > best.get(c, -2.0):
                best[c] = sim
        for c, sim in best.items():
            score[c] = score.get(c, 0.0) + sim
    cand = sorted(score, key=score.get, reverse=True)[:N_MAXSIM]
    full = [float((qv @ v.T).max(axis=1).sum()) if len(v) else -1e9
            for v in sink.fetch("cl", dim, job.id, cand)] if cand else []
    order = np.argsort(-np.array(full), kind="stable")[:k] if cand else []
    out.append({"id": "live", "chunks": [cand[i] for i in order], "ms": (time.perf_counter() - t) * 1e3})

    # this index
    t = time.perf_counter()
    with job.lock:
        qv = np.asarray(index.encoder.encode_query(question), dtype=np.float32)
    res, _ = sink.smdb.search(f"cmp:{job.id}", qv, k, planner="fixed", nprobe=4, rerank=20)
    out.append({"id": "smdb", "chunks": [int(r.doc_id) for r in res], "ms": (time.perf_counter() - t) * 1e3})
    return out


def search(job_id: str, question: str, k: int = 3) -> dict:
    """The top passages each system returns for one question."""
    job = _live(job_id)
    names = {i: n for i, n, _ in SYSTEMS}
    return {"question": question, "systems": [
        {"id": r["id"], "name": names[r["id"]], "ms": round(r["ms"], 1),
         "results": [{"chunk": c, "preview": _preview(job.texts[c])} for c in r["chunks"]]}
        for r in _search_all(job, question, k)]}


def sample(job_id: str, n: int = 20, seed: int | None = None) -> list[dict]:
    """Random chunks of the job (long enough to ask a question about), for the self-test."""
    job = _live(job_id)
    rng = np.random.default_rng(seed)
    ok = [i for i, t in enumerate(job.texts) if len(t.split()) >= 40] or list(range(job.total))
    pick = rng.choice(ok, size=min(n, len(ok)), replace=False)
    return [{"chunk": int(i), "text": job.texts[int(i)]} for i in sorted(pick)]


def selftest(job_id: str, items: list[dict]) -> dict:
    """Known-item test. items: [{chunk, question}] where the question was written for that chunk.
    A system is right when it returns that chunk: first, or within its top 5."""
    job = _live(job_id)
    names = {i: n for i, n, _ in SYSTEMS}
    tally = {i: {"top1": 0, "top5": 0, "ms": []} for i, _, _ in SYSTEMS}
    rows = []
    for it in items:
        chunk, question = int(it["chunk"]), str(it["question"]).strip()
        if not question or not 0 <= chunk < job.total:
            continue
        row = {"chunk": chunk, "question": question, "rank": {}}
        for r in _search_all(job, question, 5):
            rank = r["chunks"].index(chunk) + 1 if chunk in r["chunks"] else None
            row["rank"][r["id"]] = rank
            tally[r["id"]]["top1"] += rank == 1
            tally[r["id"]]["top5"] += rank is not None
            tally[r["id"]]["ms"].append(r["ms"])
        rows.append(row)
    n = len(rows)
    return {"questions": n, "systems": [
        {"id": i, "name": names[i],
         "top1": tally[i]["top1"] / n if n else None, "top5": tally[i]["top5"] / n if n else None,
         "found_first": tally[i]["top1"], "found_top5": tally[i]["top5"],
         "median_ms": round(float(np.median(tally[i]["ms"])), 1) if tally[i]["ms"] else None}
        for i, _, _ in SYSTEMS], "items": rows}


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def _run(job: Job, index: Index, texts: list[str], lock: threading.Lock, sink: _Sink) -> None:
    single, live, ours = job.systems
    dims = job.dims
    m_pq = index.cfg.m_pq
    try:
        # ---- 1. one embedding per chunk -> SAI
        single.state = "running"
        encode = _single_encoder(index)
        for s in range(0, len(texts), BATCH):
            if job.cancel:
                raise InterruptedError("cancelled")
            batch = texts[s:s + BATCH]
            with lock:
                t = time.perf_counter()
                emb = encode(batch)
                single.encode_s += time.perf_counter() - t
            dim = emb.shape[1]
            dims["sv"] = (dim, False)
            t = time.perf_counter()
            sink.write_vectors("sv", dim, False, [(job.id, s + i, v.tolist()) for i, v in enumerate(emb)])
            single.write_s += time.perf_counter() - t
            single.vectors += len(batch)
            single.bytes += len(batch) * (dim * 4 + 8)
            single.done = s + len(batch)
        single.state = "done"

        # ---- 2. ColBERT Live! design: token vectors, pooled by 2 -> SAI
        live.state = "running"
        for s in range(0, len(texts), BATCH):
            if job.cancel:
                raise InterruptedError("cancelled")
            batch = texts[s:s + BATCH]
            with lock:
                t = time.perf_counter()
                vecs = [pool_hierarchical(v, 2) for v in index.encoder.encode_docs(batch)]
                live.encode_s += time.perf_counter() - t
            dim = vecs[0].shape[1]
            dims["cl"] = (dim, True)
            rows = [(job.id, s + i, j, row.tolist()) for i, v in enumerate(vecs) for j, row in enumerate(v)]
            t = time.perf_counter()
            sink.write_vectors("cl", dim, True, rows)
            live.write_s += time.perf_counter() - t
            live.vectors += len(rows)
            live.bytes += len(rows) * (dim * 4 + 12)
            live.done = s + len(batch)
        live.state = "done"

        # ---- 3. this index: pooled, compressed codes -> plain tables
        ours.state = "running"
        scope = f"cmp:{job.id}"
        for s in range(0, len(texts), BATCH):
            if job.cancel:
                raise InterruptedError("cancelled")
            batch = texts[s:s + BATCH]
            with lock:
                t = time.perf_counter()
                items = [(str(s + i), *sink.smdb.quantize(v))
                         for i, v in enumerate(index.encoder.encode_docs(batch)) if len(v)]
                ours.encode_s += time.perf_counter() - t
            t = time.perf_counter()
            sink.smdb.store.write_docs(index.cfg, scope, items)
            ours.write_s += time.perf_counter() - t
            stored = sum(len(c) for _, c, _ in items)
            ours.vectors += stored
            # posting rows (code + keys) and the per-chunk copy (centroid id + code)
            ours.bytes += stored * (m_pq + 8) + stored * (m_pq + 2)
            ours.done = s + len(batch)
        ours.state = "done"
        job.state = "done"
    except Exception as e:  # report, never crash the service
        job.state = "failed"
        job.closed = True
        job.error = "cancelled" if job.cancel else f"{type(e).__name__}: {e}"
        for sys_run in job.systems:
            if sys_run.state == "running":
                sys_run.state, sys_run.error = "failed", job.error
        job.sink = None
        _safe_cleanup(sink, job)          # failed runs are not searchable: remove their rows now
