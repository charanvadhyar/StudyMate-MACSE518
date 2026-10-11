"""Baselines to compare the late-interaction index against.

  BM25                       keyword search, no model
  single-vector, exact       one embedding per document, brute-force cosine (the model's ceiling)
  single-vector, SAI ANN     the same embeddings in Cassandra 5.0 with a storage-attached vector index

  pip install sentence-transformers rank-bm25
  docker compose up -d                                  # Cassandra 5.0 on port 9043
  python -u scripts/bench_baselines.py --dataset beir/scifact/test

Cassandra 4.1 has no vector type, so the SAI rows need the 5.0 container. If it is
not reachable the script still reports BM25 and the exact single-vector numbers.
Compare the nDCG@10 column with results/bench_*.json from scripts/bench.py.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from smdb.eval import ndcg_at_k, overlap_at_k, recall_at_k      # noqa: E402

QUERY_PREFIX = {  # models that expect an instruction in front of queries
    "BAAI/bge-base-en-v1.5": "Represent this sentence for searching relevant passages: ",
    "BAAI/bge-small-en-v1.5": "Represent this sentence for searching relevant passages: ",
}


def load(name: str, max_queries: int | None):
    import ir_datasets

    ds = ir_datasets.load(name)
    qrels: dict[str, dict[str, int]] = {}
    for r in ds.qrels_iter():
        if r.relevance > 0:
            qrels.setdefault(r.query_id, {})[r.doc_id] = int(r.relevance)
    queries = [q for q in ds.queries_iter() if q.query_id in qrels]
    if max_queries:
        queries = queries[:max_queries]
    doc_ids, texts = [], []
    for d in ds.docs_iter():
        doc_ids.append(d.doc_id)
        texts.append(((getattr(d, "title", "") or "") + " " + d.text).strip())
    return doc_ids, texts, [q.text for q in queries], [qrels[q.query_id] for q in queries]


def score_run(name, runs, qrels, lat_ms, truth=None, extra=None):
    row = {"system": name,
           "ndcg10": statistics.mean(ndcg_at_k(r, q, 10) for r, q in zip(runs, qrels)),
           "recall100": statistics.mean(recall_at_k(r, q, 100) for r, q in zip(runs, qrels)),
           "ms": statistics.median(lat_ms) if lat_ms else None}
    if truth is not None:
        row["overlap10_vs_exact"] = statistics.mean(overlap_at_k(r, t, 10) for r, t in zip(runs, truth))
    row.update(extra or {})
    return row


def bm25(doc_ids, texts, queries, qrels):
    from rank_bm25 import BM25Okapi

    tok = lambda s: re.findall(r"[a-z0-9]+", s.lower())
    index = BM25Okapi([tok(t) for t in texts])
    runs, lat = [], []
    for q in queries:
        t = time.perf_counter()
        s = index.get_scores(tok(q))
        top = np.argsort(-s)[:100]
        lat.append((time.perf_counter() - t) * 1e3)
        runs.append([doc_ids[i] for i in top])
    return score_run("BM25", runs, qrels, lat)


def connect(host: str, port: int):
    from cassandra.cluster import Cluster

    cluster = Cluster([host], port=port)
    session = cluster.connect()
    version = session.execute("SELECT release_version FROM system.local").one()[0]
    if int(version.split(".")[0]) < 5:
        raise RuntimeError(f"Cassandra {version} has no vector search; 5.0 or newer is needed")
    return cluster, session, version


def sai(session, keyspace, model_tag, doc_ids, emb, q_emb, qrels, truth):
    from cassandra.concurrent import execute_concurrent_with_args

    dim = emb.shape[1]
    table = f"{keyspace}.sai_{model_tag}"
    session.execute(f"CREATE KEYSPACE IF NOT EXISTS {keyspace} WITH replication = "
                    "{'class': 'SimpleStrategy', 'replication_factor': 1}")
    session.execute(f"DROP TABLE IF EXISTS {table}")
    session.execute(f"CREATE TABLE {table} (scope text, doc_id text, v vector<float, {dim}>, "
                    "PRIMARY KEY ((scope), doc_id))")
    session.execute(f"CREATE CUSTOM INDEX ON {table}(v) USING 'StorageAttachedIndex' "
                    "WITH OPTIONS = {'similarity_function': 'cosine'}")
    ins = session.prepare(f"INSERT INTO {table} (scope, doc_id, v) VALUES ('bench', ?, ?)")
    t = time.perf_counter()
    execute_concurrent_with_args(session, ins, [(d, v.tolist()) for d, v in zip(doc_ids, emb)],
                                 concurrency=32)
    ingest_s = time.perf_counter() - t

    sel = session.prepare(f"SELECT doc_id FROM {table} WHERE scope = 'bench' "
                          "ORDER BY v ANN OF ? LIMIT 100")
    session.execute(sel, (q_emb[0].tolist(),), timeout=120)          # warm up, lets the index settle
    runs, lat = [], []
    for q in q_emb:
        t = time.perf_counter()
        rows = session.execute(sel, (q.tolist(),), timeout=60)
        runs.append([r.doc_id for r in rows])
        lat.append((time.perf_counter() - t) * 1e3)
    return score_run(f"SAI ANN {model_tag}", runs, qrels, lat, truth,
                     {"ingest_docs_per_s": len(doc_ids) / ingest_s})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--models", nargs="*", default=["sentence-transformers/all-MiniLM-L6-v2",
                                                    "BAAI/bge-base-en-v1.5"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9043)
    ap.add_argument("--keyspace", default="smdb_baseline")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--no-bm25", action="store_true")
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    doc_ids, texts, queries, qrels = load(args.dataset, args.max_queries)
    print(f"{args.dataset}: {len(texts):,} documents, {len(queries)} queries")
    rows = []
    if not args.no_bm25:
        rows.append(bm25(doc_ids, texts, queries, qrels))
        print("BM25 done")

    session = cluster = None
    try:
        cluster, session, version = connect(args.host, args.port)
        print(f"Cassandra {version} on port {args.port}")
    except Exception as e:  # report and carry on with the exact numbers
        print(f"SAI rows skipped: {type(e).__name__}: {e}")

    from sentence_transformers import SentenceTransformer

    for name in args.models:
        tag = re.sub(r"[^a-z0-9]+", "_", name.split("/")[-1].lower()).strip("_")
        cache = Path("data") / f"single_{args.dataset.replace('/', '_')}_{tag}.npz"
        if cache.exists():
            z = np.load(cache)
            emb, q_emb = z["emb"], z["q_emb"]
        else:
            model = SentenceTransformer(name, device=args.device)
            t = time.perf_counter()
            emb = model.encode(texts, batch_size=32, normalize_embeddings=True,
                               show_progress_bar=True).astype(np.float32)
            print(f"{tag}: encoded {len(texts) / (time.perf_counter() - t):.0f} documents/s")
            q_emb = model.encode([QUERY_PREFIX.get(name, "") + q for q in queries], batch_size=32,
                                 normalize_embeddings=True).astype(np.float32)
            cache.parent.mkdir(exist_ok=True)
            np.savez(cache, emb=emb, q_emb=q_emb)
        if len(q_emb) != len(queries):
            raise SystemExit(f"{cache} was built for a different query set; delete it and rerun")

        truth, lat = [], []
        for q in q_emb:
            t = time.perf_counter()
            top = np.argsort(-(emb @ q))[:100]
            lat.append((time.perf_counter() - t) * 1e3)
            truth.append([doc_ids[i] for i in top])
        rows.append(score_run(f"exact {tag}", truth, qrels, lat, None, {"dim": int(emb.shape[1])}))
        if session is not None:
            try:
                rows.append(sai(session, args.keyspace, tag, doc_ids, emb, q_emb, qrels, truth))
            except Exception as e:
                print(f"SAI failed for {tag}: {type(e).__name__}: {e}")
    if cluster is not None:
        cluster.shutdown()

    print(f"\n{'system':<34}{'nDCG@10':>9}{'R@100':>8}{'ov@10':>8}{'ms':>9}")
    for r in rows:
        ov = f"{r['overlap10_vs_exact']:.3f}" if "overlap10_vs_exact" in r else "-"
        print(f"{r['system']:<34}{r['ndcg10']:>9.4f}{r['recall100']:>8.4f}{ov:>8}{r['ms']:>9.1f}")
    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"baselines_{args.dataset.replace('/', '_')}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": args.dataset, "documents": len(texts),
                                "queries": len(queries), "rows": rows}, indent=2))
    print(f"\nsaved {path}")


if __name__ == "__main__":
    main()
