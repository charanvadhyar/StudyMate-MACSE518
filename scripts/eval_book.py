"""Measure retrieval on a textbook using the book's own review questions.

The questions printed under "Review Questions" at the end of each chapter are real study
questions, written by the authors, and each one is known to be answered in its own chapter.
That gives a labelled test set for free:

    query    = one review question
    correct  = a retrieved chunk that comes from that question's chapter

It is a chapter-level label (coarser than "this exact paragraph"), but it is objective, needs no
human or model judging, and the question chunks themselves are not in the index (kind=exercise).

Run scripts/index_book.py on the book first (it caches chunks, vectors and the quantizer).

  python -u scripts/eval_book.py --book elmasri
  python -u scripts/eval_book.py --book elmasri --single sentence-transformers/all-MiniLM-L6-v2

Systems compared on the same chunks: BM25, exact ColBERT MaxSim (no index, the ceiling), the
smdb index at several settings, and optionally exact single-vector models (--single).
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from smdb.eval import ExactCorpus                      # noqa: E402
from smdb.index import Index                           # noqa: E402
from smdb.quantizer import Quantizer                   # noqa: E402
from smdb.store import MemoryStore                     # noqa: E402

SMALL = "answerdotai/answerai-colbert-small-v1"
K = 10


def review_questions(chunks: list[dict]) -> list[dict]:
    """Split the 'Review Questions' sections into single numbered questions."""
    sections: dict[tuple[str, str], list[str]] = defaultdict(list)
    for c in chunks:
        if c["kind"] == "exercise" and c["section_path"][-1].lower().startswith("review"):
            sections[(c["chapter"], c["section_path"][-1])].append(c["text"])
    out = []
    for (chapter, _), texts in sections.items():
        text = " ".join(" ".join(texts).split())
        parts = re.split(r"(?:(?<=\s)|^)(\d{1,2}\.\d{1,2})\.\s+", text)
        for i in range(1, len(parts) - 1, 2):
            q = parts[i + 1].strip()
            if len(q.split()) >= 5:
                out.append({"id": parts[i], "chapter": chapter, "text": q})
    return out


def score(name: str, runs: list[list[str]], gold: list[str], chapter_of: dict[str, str], ms: float | None,
          extra: dict | None = None) -> dict:
    hit1, p5, hit5, rr = [], [], [], []
    for got, g in zip(runs, gold):
        ok = [chapter_of[d] == g for d in got[:K]]
        hit1.append(float(ok[0]) if ok else 0.0)
        p5.append(sum(ok[:5]) / 5)
        hit5.append(float(any(ok[:5])))
        rr.append(next((1 / (i + 1) for i, x in enumerate(ok) if x), 0.0))
    return {"system": name, "top1": statistics.mean(hit1), "p5": statistics.mean(p5),
            "any5": statistics.mean(hit5), "mrr10": statistics.mean(rr), "ms": ms, **(extra or {})}


def single_vector_sai(args, ids, name, emb, qe, gold, chapter_of, rows) -> None:
    """Cassandra's native vector search used the plain way: one embedding per chunk in a
    vector<float, d> column with a SAI index, one ANN query per question."""
    from cassandra.cluster import Cluster
    from cassandra.concurrent import execute_concurrent_with_args

    from smdb.diskusage import disk_bytes

    short = name.split("/")[-1]
    safe = re.sub(r"[^a-z0-9]+", "_", f"{args.book}_{short}".lower())[:32]
    ks = f"sv_book_{safe}"[:48]
    table = f"{ks}.embeddings"
    n, dim = emb.shape
    cluster = Cluster(["127.0.0.1"], port=args.port, protocol_version=4)
    session = cluster.connect()
    session.default_timeout = 120
    session.execute(f"CREATE KEYSPACE IF NOT EXISTS {ks} WITH replication = "
                    "{'class': 'SimpleStrategy', 'replication_factor': 1}")
    session.execute(f"CREATE TABLE IF NOT EXISTS {table} (chunk_id text PRIMARY KEY, v vector<float, {dim}>)")
    session.execute(f"CREATE CUSTOM INDEX IF NOT EXISTS ON {table}(v) USING 'StorageAttachedIndex' "
                    "WITH OPTIONS = {'similarity_function': 'dot_product'}")
    chk = session.prepare(f"SELECT chunk_id FROM {table} WHERE chunk_id = ?")
    loaded = all(session.execute(chk, (ids[i],)).one() is not None for i in (0, n // 2, n - 1))
    ingest = 0.0
    if not loaded:
        ins = session.prepare(f"INSERT INTO {table} (chunk_id, v) VALUES (?, ?)")
        todo = [(d, v.tolist()) for d, v in zip(ids, emb)]
        t = time.perf_counter()
        conc = 8
        for attempt in range(6):
            res = execute_concurrent_with_args(session, ins, todo, concurrency=conc, raise_on_first_error=False)
            todo = [r for r, (ok, _) in zip(todo, res) if not ok]
            if not todo:
                break
            conc = max(1, conc // 2)
            time.sleep(1 + attempt)
        if todo:
            raise RuntimeError("single-vector inserts keep failing; see docker logs")
        ingest = n / (time.perf_counter() - t)
        print(f"{short} on SAI: ingested at {ingest:,.1f} chunks/s")
    else:
        print(f"{short} on SAI: data already loaded")
    disk = disk_bytes(args.container, ks, "embeddings") or 0
    ann = session.prepare(f"SELECT chunk_id FROM {table} ORDER BY v ANN OF ? LIMIT {K}")
    runs, lat = [], []
    for _ in range(args.rounds):
        runs = []
        for v in qe:
            t0 = time.perf_counter()
            runs.append([r.chunk_id for r in session.execute(ann, (v.tolist(),))])
            lat.append((time.perf_counter() - t0) * 1e3)
    rows.append(score(f"{short} on SAI (1 vector/chunk)", runs, gold, chapter_of, statistics.median(lat),
                      {"disk_per_chunk": disk / n, "ingest_chunks_s": ingest,
                       "ms_stage1": statistics.median(lat), "ms_fetch": 0.0}))
    cluster.shutdown()


def cassandra_round(args, tag, ids, vecs, qv, gold, chapter_of, quant, mem_index, rows) -> None:
    """Both systems on one Cassandra: load (timed), compact, measure disk, then interleaved query passes."""
    from cassandra.cluster import Cluster
    from cassandra.concurrent import execute_concurrent_with_args

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bench_colbertlive import pool_query
    from smdb.diskusage import disk_bytes
    from smdb.pooling import pool_hierarchical
    from smdb.store import CassandraStore

    safe = re.sub(r"[^a-z0-9]+", "_", f"{args.book}_{tag}".lower())[:32]
    n = len(ids)

    # ---------------- smdb
    ks_a = f"smdb_book_{safe}"[:48]
    store = CassandraStore(port=args.port, keyspace=ks_a)
    index = Index(store, quant, pool="centroid")
    scope = "book"
    items = [(d, *index.quantize(v)) for d, v in zip(ids, vecs) if len(v)]
    stored = sum(len(c) for _, c, _ in items)
    ingest_a = 0.0
    if int(store.partition_sizes(quant.cfg, scope).sum()) != stored:
        t = time.perf_counter()
        for s0 in range(0, len(items), 256):
            store.write_docs(quant.cfg, scope, items[s0:s0 + 256])
        ingest_a = n / (time.perf_counter() - t)
        print(f"smdb: ingested at {ingest_a:,.1f} chunks/s")
    else:
        print("smdb: data already loaded")
    disk_a = sum(disk_bytes(args.container, ks_a, t) or 0 for t in ("postings", "doc_tokens", "partition_stats"))
    index._sizes.clear()

    # ---------------- ColBERT Live! design on SAI
    ks_b = f"cl_book_{safe}"[:48]
    table = f"{ks_b}.embeddings"
    pooled = [pool_hierarchical(v, 2) for v in vecs]
    dim = pooled[0].shape[1]
    n_vec = sum(len(v) for v in pooled)
    cluster = Cluster(["127.0.0.1"], port=args.port, protocol_version=4)
    session = cluster.connect()
    session.default_timeout = 120
    session.execute(f"CREATE KEYSPACE IF NOT EXISTS {ks_b} WITH replication = "
                    "{'class': 'SimpleStrategy', 'replication_factor': 1}")
    session.execute(f"CREATE TABLE IF NOT EXISTS {table} (chunk_id text, embedding_id int, "
                    f"v vector<float, {dim}>, PRIMARY KEY (chunk_id, embedding_id))")
    session.execute(f"CREATE CUSTOM INDEX IF NOT EXISTS ON {table}(v) USING 'StorageAttachedIndex' "
                    "WITH OPTIONS = {'similarity_function': 'dot_product'}")
    chk = session.prepare(f"SELECT count(*) FROM {table} WHERE chunk_id = ?")
    loaded = all(session.execute(chk, (ids[i],)).one()[0] == len(pooled[i]) for i in (0, n // 2, n - 1))
    ingest_b = 0.0
    if not loaded:
        ins = session.prepare(f"INSERT INTO {table} (chunk_id, embedding_id, v) VALUES (?, ?, ?)")
        t = time.perf_counter()
        batch: list = []
        done = 0

        def flush(rows_):
            conc = 8                      # SAI's graph builder rejects more than ~13 concurrent writes
            for attempt in range(6):
                res = execute_concurrent_with_args(session, ins, rows_, concurrency=conc, raise_on_first_error=False)
                rows_ = [r for r, (ok, _) in zip(rows_, res) if not ok]
                if not rows_:
                    return
                conc = max(1, conc // 2)
                time.sleep(1 + attempt)
            raise RuntimeError("ColBERT Live! inserts keep failing; see docker logs")

        for d, v in zip(ids, pooled):
            batch.extend((d, j, row.tolist()) for j, row in enumerate(v))
            if len(batch) >= 20_000:
                flush(batch); done += len(batch); batch = []
                print(f"  ColBERT Live!: inserted {done:,}/{n_vec:,} vectors, {time.perf_counter() - t:.0f}s")
        if batch:
            flush(batch)
        ingest_b = n / (time.perf_counter() - t)
        print(f"ColBERT Live!: ingested at {ingest_b:,.1f} chunks/s")
    else:
        print("ColBERT Live!: data already loaded")
    disk_b = disk_bytes(args.container, ks_b, "embeddings") or 0
    ann_stmt = session.prepare(f"SELECT chunk_id, similarity_dot_product(?, v) AS s FROM {table} "
                               "ORDER BY v ANN OF ? LIMIT ?")
    chunk_stmt = session.prepare(f"SELECT v FROM {table} WHERE chunk_id = ?")
    pos = {d: i for i, d in enumerate(ids)}
    pq = [pool_query(np.asarray(q, dtype=np.float32), 0.03) for q in qv]

    def run_many(stmt, params, conc):
        for attempt in range(4):
            try:
                return execute_concurrent_with_args(session, stmt, params, concurrency=conc)
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 + 2 * attempt)

    def smdb_pass(nprobe, rerank):
        runs, tot, s1, s2 = [], [], [], []
        for q in qv:
            res, st = index.search(scope, q, K, planner="fixed", nprobe=nprobe, rerank=rerank)
            runs.append([r.doc_id for r in res])
            tot.append(st.ms["total"]); s1.append(st.ms.get("read_partitions", 0.0)); s2.append(st.ms.get("read_docs", 0.0))
        return runs, tot, s1, s2

    def cl_pass(n_ann, n_maxsim):
        runs, tot, s1, s2 = [], [], [], []
        for q in pq:
            t0 = time.perf_counter()
            best: dict[tuple[int, int], float] = {}
            for j, r in enumerate(run_many(ann_stmt, [(v.tolist(), v.tolist(), n_ann) for v in q], 8)):
                for row in r.result_or_exc:
                    key = (pos[row.chunk_id], j)
                    if row.s > best.get(key, -2.0):
                        best[key] = row.s
            t1 = time.perf_counter()
            sc: dict[int, float] = {}
            for (d, _), v in best.items():
                sc[d] = sc.get(d, 0.0) + v
            cand = sorted(sc, key=sc.get, reverse=True)[:n_maxsim]
            got = run_many(chunk_stmt, [(ids[d],) for d in cand], 16)
            full_v = [np.array([row.v for row in r.result_or_exc], dtype=np.float32) for r in got]
            t2 = time.perf_counter()
            full = [float((q @ v.T).max(axis=1).sum()) if len(v) else -1e9 for v in full_v]
            runs.append([ids[cand[i]] for i in np.argsort(-np.array(full), kind="stable")[:K]])
            tot.append((time.perf_counter() - t0) * 1e3); s1.append((t1 - t0) * 1e3); s2.append((t2 - t1) * 1e3)
        return runs, tot, s1, s2

    arms = [(f"smdb index, nprobe=4, {args.rerank} fetches", lambda: smdb_pass(4, args.rerank), disk_a, ingest_a),
            (f"smdb index, nprobe=8, {args.rerank} fetches", lambda: smdb_pass(8, args.rerank), disk_a, ingest_a),
            ("ColBERT Live! on SAI, 20 fetches", lambda: cl_pass(171, 20), disk_b, ingest_b),
            ("ColBERT Live! on SAI, 50 fetches", lambda: cl_pass(171, 50), disk_b, ingest_b)]
    acc = {name: ([], [], [], None) for name, *_ in arms}
    for rnd in range(args.rounds):
        for name, fn, _, _ in arms:
            runs, tot, s1, s2 = fn()
            a = acc[name]
            a[0].extend(tot); a[1].extend(s1); a[2].extend(s2)
            acc[name] = (a[0], a[1], a[2], runs)
            print(f"  pass {rnd + 1}/{args.rounds}: {name} done")
    for name, _, disk, ingest in arms:
        tot, s1, s2, runs = acc[name]
        rows.append(score(name, runs, gold, chapter_of, statistics.median(tot),
                          {"disk_per_chunk": disk / n, "ingest_chunks_s": ingest,
                           "ms_stage1": statistics.median(s1), "ms_fetch": statistics.median(s2)}))
    cluster.shutdown()
    store.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True)
    ap.add_argument("--model", default=SMALL)
    ap.add_argument("--encoder", choices=["colbert", "hash"], default="colbert")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--single", nargs="*", default=[],
                    help="sentence-transformers models to add as exact single-vector baselines")
    ap.add_argument("--nprobes", type=int, nargs="*", default=[1, 2, 4, 8])
    ap.add_argument("--rerank", type=int, default=20)
    ap.add_argument("--pool", choices=["none", "centroid", "hierarchical"], default="centroid",
                    help="pooling for the in-memory index rows (the --cassandra part always uses centroid)")
    ap.add_argument("--colbertlive", action="store_true",
                    help="add the ColBERT Live! design (DataStax): float vectors pooled by 2, one ANN "
                         "query per query vector, exact MaxSim on the fetched chunks. The ANN step is "
                         "brute force here, i.e. a perfect vector index: its best case for quality")
    ap.add_argument("--cassandra", action="store_true",
                    help="also run both systems on a real Cassandra 5.0: ingest speed, on-disk size "
                         "after compaction, and query latency, interleaved so both see the same machine state")
    ap.add_argument("--port", type=int, default=9044)
    ap.add_argument("--container", default="smdb-cassandra-jdk21")
    ap.add_argument("--rounds", type=int, default=2, help="--cassandra: query passes per system")
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    chunks = [json.loads(l) for l in (Path("data/chunks") / f"{args.book}.jsonl").read_text(encoding="utf-8").splitlines()]
    body = [c for c in chunks if c["kind"] == "body"]
    ids = [c["doc_id"] for c in body]
    chapter_of = {c["doc_id"]: c["chapter"] for c in body}
    questions = review_questions(chunks)[: args.max_queries]
    gold = [q["chapter"] for q in questions]
    per_ch = defaultdict(int)
    for c in body:
        per_ch[c["chapter"]] += 1
    chance = statistics.mean(per_ch[g] / len(body) for g in gold)
    print(f"{args.book}: {len(body):,} body chunks, {len(questions)} review questions from "
          f"{len(set(gold))} chapters; a random chunk is from the right chapter {chance:.1%} of the time")

    rows = []

    # ---- BM25
    try:
        from rank_bm25 import BM25Okapi
        tok = lambda s: re.findall(r"[a-z0-9]+", s.lower())      # noqa: E731
        head = lambda c: " > ".join(c["section_path"][-3:]) + ". " + c["text"]   # noqa: E731
        bm = BM25Okapi([tok(head(c)) for c in body])
        runs, lat = [], []
        for q in questions:
            t = time.perf_counter()
            s = bm.get_scores(tok(q["text"]))
            runs.append([ids[i] for i in np.argsort(-s)[:K]])
            lat.append((time.perf_counter() - t) * 1e3)
        rows.append(score("BM25", runs, gold, chapter_of, statistics.median(lat)))
        print("BM25 done")
    except ImportError:
        print("BM25 skipped (pip install rank-bm25)")

    # ---- ColBERT: exact, then the index
    if args.encoder == "hash":
        from smdb.encoder import HashEncoder
        enc, tag = HashEncoder(96), "hash"
    else:
        from smdb.encoder import ColbertEncoder, model_tag
        enc, tag = ColbertEncoder(args.model, device=args.device, markers="colbert"), model_tag(args.model)
    cache = Path("data") / f"book_{args.book}_{tag}_{len(body)}.npz"
    qfiles = sorted(Path("data").glob(f"quantizer_book_{args.book}_{tag}_*.npz"))
    if not cache.exists() or not qfiles:
        raise SystemExit(f"missing {cache} or its quantizer: run scripts/index_book.py on the book first")
    z = np.load(cache)
    vecs = np.split(z["vecs"], np.cumsum(z["lens"])[:-1])
    qv = [enc.encode_query(q["text"]) for q in questions]
    exact = ExactCorpus(ids, vecs)
    t = time.perf_counter()
    truth = [[d for d, _ in exact.search(q, K)] for q in qv]
    rows.append(score("ColBERT exact MaxSim (ceiling)", truth, gold, chapter_of, None,
                      {"bytes_per_chunk": sum(len(v) for v in vecs) * vecs[0].shape[1] * 4 / len(vecs)}))
    print(f"exact done ({time.perf_counter() - t:.0f}s)")

    quant = Quantizer.load(str(qfiles[-1]))
    pool_tag = "" if args.pool == "centroid" else f" ({args.pool} pool)"
    store = MemoryStore()
    index = Index(store, quant, pool=args.pool)
    items = [(d, *index.quantize(v)) for d, v in zip(ids, vecs) if len(v)]
    for s in range(0, len(items), 256):
        store.write_docs(quant.cfg, "eval", items[s:s + 256])
    stored = sum(len(c) for _, c, _ in items)
    bpc = stored * (2 + 2 * quant.cfg.m_pq) / len(items)
    for nprobe in args.nprobes:
        runs, lat, parts, ov = [], [], [], []
        for q, tr in zip(qv, truth):
            res, st = index.search("eval", q, K, planner="fixed", nprobe=nprobe, rerank=args.rerank)
            runs.append([r.doc_id for r in res])
            lat.append(st.ms["total"]); parts.append(st.partitions_read)
            ov.append(len(set(runs[-1]) & set(tr)) / K)
        rows.append(score(f"smdb index{pool_tag}, nprobe={nprobe}, {args.rerank} fetches", runs, gold, chapter_of,
                          statistics.median(lat),
                          {"bytes_per_chunk": bpc, "partitions": statistics.mean(parts),
                           "overlap_exact": statistics.mean(ov)}))
    print("index done")

    # ---- ColBERT Live! design, same vectors (see scripts/bench_colbertlive.py)
    if args.colbertlive:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from bench_colbertlive import pool_query
        from smdb.pooling import pool_hierarchical
        pooled = [pool_hierarchical(v, 2) for v in vecs]
        lens = np.array([len(v) for v in pooled])
        starts = np.r_[0, np.cumsum(lens)]
        owner = np.repeat(np.arange(len(pooled)), lens)
        flat = np.concatenate(pooled)
        raw = flat.shape[0] * flat.shape[1] * 4 / len(pooled)
        for n_ann, n_maxsim in ((171, 20), (171, 50)):
            runs, ov = [], []
            for q0, tr in zip(qv, truth):
                q = pool_query(np.asarray(q0, dtype=np.float32), 0.03)
                sim = q @ flat.T
                top = np.argpartition(-sim, n_ann, axis=1)[:, :n_ann]
                sc: dict[int, float] = {}
                for j in range(len(q)):
                    best: dict[int, float] = {}
                    for idx in top[j]:
                        d = int(owner[idx])
                        if sim[j, idx] > best.get(d, -2.0):
                            best[d] = float(sim[j, idx])
                    for d, v in best.items():
                        sc[d] = sc.get(d, 0.0) + v
                cand = sorted(sc, key=sc.get, reverse=True)[:n_maxsim]
                full = [float((q @ flat[starts[d]:starts[d + 1]].T).max(axis=1).sum()) for d in cand]
                runs.append([ids[cand[i]] for i in np.argsort(-np.array(full), kind="stable")[:K]])
                ov.append(len(set(runs[-1]) & set(tr)) / K)
            rows.append(score(f"ColBERT Live! design, {n_maxsim} fetches", runs, gold, chapter_of, None,
                              {"bytes_per_chunk": raw, "overlap_exact": statistics.mean(ov)}))
        print("ColBERT Live! design done")

    # ---- single-vector baselines (exact search: the best an ANN index over them could do)
    single_data = {}
    if args.single:
        from sentence_transformers import SentenceTransformer
        texts = [" > ".join(c["section_path"][-3:]) + ". " + c["text"] for c in body]
        for name in args.single:
            short = name.split("/")[-1]
            sc = Path("data") / f"book_{args.book}_single_{re.sub(r'[^a-z0-9]+', '_', short.lower())}_{len(body)}.npy"
            model = SentenceTransformer(name, device=args.device)
            if sc.exists():
                emb = np.load(sc)
            else:
                emb = model.encode(texts, batch_size=32, normalize_embeddings=True, show_progress_bar=True)
                np.save(sc, emb)
            prefix = "Represent this sentence for searching relevant passages: " if "bge" in name.lower() else ""
            qe = model.encode([prefix + q["text"] for q in questions], normalize_embeddings=True)
            single_data[name] = (np.asarray(emb, dtype=np.float32), np.asarray(qe, dtype=np.float32))
            runs = [[ids[i] for i in np.argsort(-(emb @ v))[:K]] for v in qe]
            rows.append(score(f"{short}, exact single vector", runs, gold, chapter_of, None,
                              {"bytes_per_chunk": emb.shape[1] * 4}))
            print(f"{short} done")

    if args.cassandra:
        cassandra_round(args, tag, ids, vecs, qv, gold, chapter_of, quant, index, rows)
        for name, (emb, qe) in single_data.items():
            single_vector_sai(args, ids, name, emb, qe, gold, chapter_of, rows)

    print(f"\n{'system':<44}{'top-1':>7}{'P@5':>7}{'any@5':>7}{'MRR@10':>8}{'B/chunk':>10}{'ms':>7}")
    for r in [r for r in rows if "disk_per_chunk" not in r]:
        b = f"{r['bytes_per_chunk']:,.0f}" if r.get("bytes_per_chunk") else "-"
        ms = f"{r['ms']:.1f}" if r["ms"] is not None else "-"
        print(f"{r['system']:<44}{r['top1']:>7.3f}{r['p5']:>7.3f}{r['any5']:>7.3f}{r['mrr10']:>8.3f}{b:>10}{ms:>7}")
    print("\ntop-1 = the first result is from the question's chapter; P@5 = share of the top 5 that are; "
          "any@5 = at least one of the top 5 is.\nms for the index excludes encoding the question. B/chunk is the "
          "stored representation before database overhead\n(for ColBERT Live! that is the raw vectors only; "
          "its SAI index on disk adds roughly 2.5x on top).")
    cass = [r for r in rows if "disk_per_chunk" in r]
    if cass:
        print(f"\nOn Cassandra ({args.container}), medians over {args.rounds} interleaved passes:")
        print(f"{'system':<40}{'top-1':>7}{'P@5':>7}{'disk B/chunk':>14}{'ingest ch/s':>13}"
              f"{'ms':>8}{'stage1':>8}{'fetch':>8}")
        for r in cass:
            print(f"{r['system']:<40}{r['top1']:>7.3f}{r['p5']:>7.3f}{r['disk_per_chunk']:>14,.0f}"
                  f"{r['ingest_chunks_s']:>13.1f}{r['ms']:>8.1f}{r['ms_stage1']:>8.1f}{r['ms_fetch']:>8.1f}")
        print("stage1 = posting-partition reads (smdb) or ANN queries (ColBERT Live!); fetch = reading the "
              "candidates' vectors/codes;\nfor the single-vector row stage1 is the one ANN query. ms excludes encoding the question. ingest = writing to Cassandra, "
              "encoding excluded; a system whose data was already loaded shows 0.")
    out = Path(args.out); out.mkdir(exist_ok=True)
    path = out / f"book_{args.book}_{tag}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"book": args.book, "chunks": len(body), "questions": len(questions),
                                "chance": chance, "rows": rows}, indent=2))
    print(f"saved {path}")


if __name__ == "__main__":
    main()
