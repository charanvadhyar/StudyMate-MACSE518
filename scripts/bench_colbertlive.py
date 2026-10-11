"""Baseline arm: the ColBERT Live! design (DataStax, github.com/jbellis/colbert-live), re-implemented.

What that system does (read from its source, October 2024):
  storage   one row per token vector, uncompressed:  (chunk_id, embedding_id, vector<float, dim>)
  index     a SAI vector index over every token vector
  pooling   document tokens pooled by a factor of 2 (hierarchical); near-duplicate query vectors pooled
  stage 1   one ANN query per query vector, LIMIT n_ann_docs; per chunk, sum over query vectors of
            the best similarity returned
  stage 2   fetch all vectors of the top n_maxsim_candidates chunks and compute exact MaxSim

This script reproduces that pipeline on the SAME cached token vectors scripts/bench.py uses, so
the two systems differ only in architecture.

  --ann exact   stage 1 by brute force in NumPy. Needs no database; it is the best case for the
                design (a perfect ANN index) and gives its quality and logical storage.
  --ann sai     stage 1 through a real SAI index on Cassandra 5.0 (docker compose up -d; port 9043).
                Adds ingest time, latency and on-disk size.

  python -u scripts/bench_colbertlive.py --dataset beir/scifact/test --ann exact
  python -u scripts/bench_colbertlive.py --dataset beir/scifact/test --ann sai

This is our re-implementation for comparison, not DataStax's code; parameter defaults follow theirs
(n_ann_docs 171 and n_maxsim_candidates 20 for k=10; their BEIR script uses n_ann_docs 240).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench import load_beir, synthetic                              # noqa: E402
from smdb.eval import ExactCorpus, ndcg_at_k, overlap_at_k          # noqa: E402
from smdb.diskusage import disk_bytes                               # noqa: E402
from smdb.pooling import pool_hierarchical                          # noqa: E402

K = 10


def pool_query(q: np.ndarray, max_distance: float) -> np.ndarray:
    """ColBERT Live!'s query pooling: average-linkage clustering at a cosine-distance threshold."""
    if not max_distance or len(q) < 2:
        return q
    from sklearn.cluster import AgglomerativeClustering

    labels = AgglomerativeClustering(metric="cosine", linkage="average",
                                     distance_threshold=max_distance, n_clusters=None).fit_predict(q)
    out = []
    for lab in sorted(set(labels)):
        v = q[labels == lab].mean(axis=0)
        out.append(v / np.linalg.norm(v))
    return np.stack(out).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--model")
    ap.add_argument("--markers", default="legacy")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--ann", choices=["exact", "sai"], default="exact")
    ap.add_argument("--doc-pool", type=int, default=2)
    ap.add_argument("--query-pool", type=float, default=0.03)
    ap.add_argument("--n-ann", type=int, nargs="*", default=[171, 240])
    ap.add_argument("--n-maxsim", type=int, nargs="*", default=[20, 50])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9043)
    ap.add_argument("--keyspace", default="colbertlive_bench")
    ap.add_argument("--container", default="smdb-cassandra")
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--write-concurrency", type=int, default=8,
                    help="concurrent inserts; Cassandra 5.0's SAI graph builder rejects writes above "
                         "roughly the server's core count ('outstanding pooled objects' error)")
    ap.add_argument("--reuse", action="store_true",
                    help="--ann sai: query the table left by an earlier run instead of reloading it")
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    name = "synthetic" if args.synthetic else args.dataset
    doc_ids, docs, queries, qrels = (synthetic() if args.synthetic else
                                     load_beir(args.dataset, args.markers, args.device, args.max_queries,
                                               args.model))
    n_tokens = sum(len(v) for v in docs)
    dim = docs[0].shape[1]
    t = time.perf_counter()
    pooled = [pool_hierarchical(v, args.doc_pool) for v in docs]
    lens = np.array([len(v) for v in pooled])
    n_vec = int(lens.sum())
    print(f"{name}: {len(docs):,} chunks, {n_tokens:,} tokens -> {n_vec:,} vectors after pooling by "
          f"{args.doc_pool} ({time.perf_counter() - t:.0f}s); {n_vec / len(docs):.0f} vectors and "
          f"{n_vec * dim * 4 / len(docs):,.0f} bytes per chunk of raw vectors, before the index")
    starts = np.r_[0, np.cumsum(lens)]
    owner = np.repeat(np.arange(len(docs)), lens)
    flat = np.concatenate(pooled)
    pq = [pool_query(np.asarray(q, dtype=np.float32), args.query_pool) for q in queries]
    print(f"query vectors: {statistics.mean(len(q) for q in queries):.1f} -> "
          f"{statistics.mean(len(q) for q in pq):.1f} after pooling")

    exact = ExactCorpus(doc_ids, docs)
    truth = [[d for d, _ in exact.search(q, K)] for q in queries]

    session = cluster = table = None
    info = {"ingest_s": None, "disk_bytes": None}
    if args.ann == "sai":
        from cassandra.cluster import Cluster
        from cassandra.concurrent import execute_concurrent_with_args

        # protocol v4: v5 adds checksummed framing, and the Python driver intermittently reports
        # "CRC mismatch on header" on large concurrent responses with it
        cluster = Cluster([args.host], port=args.port, protocol_version=4)
        session = cluster.connect()
        version = session.execute("SELECT release_version FROM system.local").one()[0]
        print(f"Cassandra {version}")
        session.default_timeout = 120
        table = f"{args.keyspace}.embeddings"
        session.execute(f"CREATE KEYSPACE IF NOT EXISTS {args.keyspace} WITH replication = "
                        "{'class': 'SimpleStrategy', 'replication_factor': 1}")
        ins = None
        if args.reuse:
            # a full count(*) over ~700k vector rows fails on the server; spot-check chunks instead
            chk = session.prepare(f"SELECT count(*) FROM {table} WHERE chunk_id = ?")
            for i in sorted({0, len(doc_ids) // 2, len(doc_ids) - 1}):
                have = session.execute(chk, (doc_ids[i],)).one()[0]
                if have != len(pooled[i]):
                    raise SystemExit(f"--reuse: chunk {doc_ids[i]} has {have} vectors in {table}, expected "
                                     f"{len(pooled[i])}; run once without --reuse")
            print(f"reusing the vectors already in {table}")
        else:
            session.execute(f"DROP TABLE IF EXISTS {table}")
            session.execute(f"CREATE TABLE {table} (chunk_id text, embedding_id int, "
                            f"v vector<float, {dim}>, PRIMARY KEY (chunk_id, embedding_id))")
            session.execute(f"CREATE CUSTOM INDEX ON {table}(v) USING 'StorageAttachedIndex' "
                            "WITH OPTIONS = {'similarity_function': 'dot_product'}")
            ins = session.prepare(f"INSERT INTO {table} (chunk_id, embedding_id, v) VALUES (?, ?, ?)")
            def insert(rows_):
                """Insert with retries: the SAI graph builder fails writes under too much concurrency."""
                conc = args.write_concurrency
                for attempt in range(6):
                    res = execute_concurrent_with_args(session, ins, rows_, concurrency=conc,
                                                       raise_on_first_error=False)
                    rows_ = [r for r, (ok, _) in zip(rows_, res) if not ok]
                    if not rows_:
                        return
                    conc = max(1, conc // 2)
                    print(f"  {len(rows_):,} writes failed; retrying with concurrency {conc}")
                    time.sleep(1 + attempt)
                raise RuntimeError(f"{len(rows_):,} writes still failing after retries; see docker logs")

            t = time.perf_counter()
            batch = []
            done = 0
            for d, v in zip(doc_ids, pooled):
                batch.extend((d, j, row.tolist()) for j, row in enumerate(v))
                if len(batch) >= 20_000:
                    insert(batch)
                    done += len(batch); batch = []
                    print(f"  inserted {done:,}/{n_vec:,} vectors, {time.perf_counter() - t:.0f}s")
            if batch:
                insert(batch)
            info["ingest_s"] = time.perf_counter() - t
            print(f"ingest: {len(docs) / info['ingest_s']:,.1f} chunks/s ({info['ingest_s']:.0f}s)")
        ann_stmt = session.prepare(f"SELECT chunk_id, similarity_dot_product(?, v) AS s FROM {table} "
                                   "ORDER BY v ANN OF ? LIMIT ?")
        chunk_stmt = session.prepare(f"SELECT v FROM {table} WHERE chunk_id = ?")
        doc_pos = {d: i for i, d in enumerate(doc_ids)}
        session.execute(ann_stmt, (pq[0][0].tolist(), pq[0][0].tolist(), 10))     # warm up
        info["disk_bytes"] = disk_bytes(args.container, args.keyspace, "embeddings")
        if info["disk_bytes"]:
            print(f"on disk after compaction, table + SAI index: {info['disk_bytes'] / len(docs):,.0f} "
                  f"bytes per chunk ({info['disk_bytes'] / 1e6:,.0f} MB total)")

        def run_many(stmt, params, conc):
            """execute_concurrent with a few retries for transient connection errors."""
            for attempt in range(4):
                try:
                    return execute_concurrent_with_args(session, stmt, params, concurrency=conc)
                except Exception as e:
                    if attempt == 3:
                        raise
                    print(f"  transient error ({type(e).__name__}); retrying")
                    time.sleep(2 + 2 * attempt)

    rows = []
    for n_ann in args.n_ann:
        for n_maxsim in args.n_maxsim:
            nd, ov, lat, nq, lat_ann, lat_fetch = [], [], [], [], [], []
            for qi, q in enumerate(pq):
                t = time.perf_counter()
                best: dict[tuple[int, int], float] = {}
                if args.ann == "exact":
                    sim = q @ flat.T                                    # [nq, n_vec]
                    top = np.argpartition(-sim, min(n_ann, sim.shape[1] - 1), axis=1)[:, :n_ann]
                    for j in range(len(q)):
                        for idx in top[j]:
                            key = (int(owner[idx]), j)
                            s = float(sim[j, idx])
                            if s > best.get(key, -2.0):
                                best[key] = s
                else:
                    res = run_many(ann_stmt, [(v.tolist(), v.tolist(), n_ann) for v in q], 8)
                    for j, r in enumerate(res):
                        for row in r.result_or_exc:
                            key = (doc_pos[row.chunk_id], j)
                            if row.s > best.get(key, -2.0):
                                best[key] = row.s
                t_ann = time.perf_counter()
                score: dict[int, float] = {}
                for (d, _), s in best.items():
                    score[d] = score.get(d, 0.0) + s
                cand = sorted(score, key=score.get, reverse=True)[:n_maxsim]
                if args.ann == "exact":
                    vecs = [flat[starts[d]:starts[d + 1]] for d in cand]
                else:
                    res = run_many(chunk_stmt, [(doc_ids[d],) for d in cand], 16)
                    vecs = [np.array([row.v for row in r.result_or_exc], dtype=np.float32) for r in res]
                t_fetch = time.perf_counter()
                full = [float((q @ v.T).max(axis=1).sum()) if len(v) else -1e9 for v in vecs]
                order = np.argsort(-np.array(full), kind="stable")[:K]
                got = [doc_ids[cand[i]] for i in order]
                lat.append((time.perf_counter() - t) * 1e3)
                lat_ann.append((t_ann - t) * 1e3)
                lat_fetch.append((t_fetch - t_ann) * 1e3)
                nq.append(len(q))
                ov.append(overlap_at_k(got, truth[qi], K))
                if qrels is not None:
                    nd.append(ndcg_at_k(got, qrels[qi], K))
            rows.append({"n_ann_docs": n_ann, "n_maxsim": n_maxsim,
                         "ann_queries": statistics.mean(nq), "fetched": n_maxsim,
                         "ndcg10": statistics.mean(nd) if nd else None,
                         "overlap10": statistics.mean(ov), "ms": statistics.median(lat),
                         "ms_ann": statistics.median(lat_ann), "ms_fetch": statistics.median(lat_fetch)})
            print(f"  n_ann={n_ann} n_maxsim={n_maxsim} done")
    if cluster is not None:
        cluster.shutdown()

    print(f"\n{'n_ann':>6}{'n_maxsim':>10}{'ANN queries':>13}{'fetch':>7}{'nDCG@10':>9}{'ov@10':>8}{'ms':>9}{'ANN ms':>9}{'fetch ms':>10}")
    for r in rows:
        nd = f"{r['ndcg10']:.4f}" if r["ndcg10"] is not None else "-"
        print(f"{r['n_ann_docs']:>6}{r['n_maxsim']:>10}{r['ann_queries']:>13.1f}{r['fetched']:>7}"
              f"{nd:>9}{r['overlap10']:>8.3f}{r['ms']:>9.1f}{r['ms_ann']:>9.1f}{r['ms_fetch']:>10.1f}")
    print(f"\nstorage: {n_vec / len(docs):.0f} vectors and {n_vec * dim * 4 / len(docs):,.0f} bytes per chunk "
          "of raw vectors (logical)")
    if info["disk_bytes"]:
        print(f"on disk, table + SAI index: {info['disk_bytes'] / len(docs):,.0f} bytes per chunk "
              f"({info['disk_bytes'] / 1e6:,.0f} MB total)")
    if args.ann == "exact":
        print("ms in --ann exact mode is NumPy brute force and says nothing about the real system.")

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"colbertlive_{name.replace('/', '_')}_{args.ann}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": name, "ann": args.ann, "doc_pool": args.doc_pool,
                                "query_pool": args.query_pool, "vectors": n_vec, "chunks": len(docs),
                                "raw_bytes_per_chunk": n_vec * dim * 4 / len(docs), **info,
                                "rows": rows}, indent=2))
    print(f"saved {path}")


if __name__ == "__main__":
    main()
