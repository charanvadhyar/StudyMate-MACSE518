"""Planner benchmark: fixed per-token probing vs the joint `mass` planner vs the oracle.

  python scripts/bench.py --dataset beir/scifact/test          # encodes with ColBERT, caches in data/
  python scripts/bench.py --synthetic                          # no model; checks the pipeline only
  python scripts/bench.py --dataset beir/scifact/test --store cassandra

For every setting it reports, averaged over queries:
  parts     posting partitions read            (the cost the planner controls)
  tokens    token codes scored in stage 1
  nDCG@10   against the dataset's relevance labels (real datasets only)
  ov@10     overlap with exact brute-force MaxSim top-10
  ms        median search latency, query encoding excluded

Go / no-go for the planner idea: at equal nDCG@10, how many fewer partitions does
`mass` read than `fixed`, and how far are both from `oracle`?
Synthetic numbers say nothing about retrieval quality; use them only as a smoke test.
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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from smdb import Index, IndexConfig, Quantizer                      # noqa: E402
from smdb.eval import ExactCorpus, ndcg_at_k, overlap_at_k          # noqa: E402
from smdb.store import MemoryStore                                  # noqa: E402


def synthetic(n_docs=2000, n_queries=60, dim=128, topics=200, seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.standard_normal((topics, dim)).astype(np.float32)

    def toks(n, topic_ids):
        v = centers[rng.choice(topic_ids, n)] + 0.6 * rng.standard_normal((n, dim)).astype(np.float32)
        return v / np.linalg.norm(v, axis=1, keepdims=True)

    doc_topics = [rng.choice(topics, 6, replace=False) for _ in range(n_docs)]
    docs = [toks(int(rng.integers(40, 160)), t) for t in doc_topics]
    queries = [toks(int(rng.integers(6, 20)), doc_topics[int(rng.integers(n_docs))][:3])
               for _ in range(n_queries)]
    return [f"d{i}" for i in range(n_docs)], docs, queries, None


def load_beir(name: str, markers: str, device: str, max_queries: int | None):
    import ir_datasets
    from tqdm import tqdm
    from smdb.encoder import ColbertEncoder

    cache = Path("data") / f"{name.replace('/', '_')}_{markers}.npz"
    ds = ir_datasets.load(name)
    qrels: dict[str, dict[str, int]] = {}
    for r in ds.qrels_iter():
        if r.relevance > 0:
            qrels.setdefault(r.query_id, {})[r.doc_id] = int(r.relevance)
    queries = [q for q in ds.queries_iter() if q.query_id in qrels]
    if max_queries:
        queries = queries[:max_queries]

    if cache.exists():
        z = np.load(cache, allow_pickle=False)
        doc_ids = [str(x) for x in z["doc_ids"]]
        docs = np.split(z["doc_vecs"], np.cumsum(z["doc_lens"])[:-1])
        cached_q = {str(i): v for i, v in zip(z["q_ids"], np.split(z["q_vecs"], np.cumsum(z["q_lens"])[:-1]))}
    else:
        enc = ColbertEncoder(device=device, markers=markers)
        doc_ids, texts = [], []
        for d in ds.docs_iter():
            doc_ids.append(d.doc_id)
            texts.append(((getattr(d, "title", "") or "") + " " + d.text).strip())
        docs = []
        for s in tqdm(range(0, len(texts), 16), desc="encode docs"):
            docs.extend(enc.encode_docs(texts[s:s + 16]))
        all_q = [q for q in ds.queries_iter() if q.query_id in qrels]
        cached_q = {q.query_id: enc.encode_query(q.text) for q in tqdm(all_q, desc="encode queries")}
        cache.parent.mkdir(exist_ok=True)
        np.savez(cache, doc_ids=np.array(doc_ids), doc_vecs=np.concatenate(docs),
                 doc_lens=np.array([len(v) for v in docs]),
                 q_ids=np.array(list(cached_q)), q_vecs=np.concatenate(list(cached_q.values())),
                 q_lens=np.array([len(v) for v in cached_q.values()]))
    return doc_ids, docs, [cached_q[q.query_id] for q in queries], [qrels[q.query_id] for q in queries]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--store", choices=["memory", "cassandra"], default="memory")
    ap.add_argument("--keyspace", default="smdb_bench")
    ap.add_argument("--markers", default="legacy", choices=["legacy", "colbert"])
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--k-ivf", type=int, default=1024)
    ap.add_argument("--m-pq", type=int, default=32)
    ap.add_argument("--rerank", type=int, default=100)
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()

    name = "synthetic" if args.synthetic else args.dataset
    doc_ids, docs, queries, qrels = (synthetic() if args.synthetic else
                                     load_beir(args.dataset, args.markers, args.device, args.max_queries))
    n_tokens = sum(len(v) for v in docs)
    print(f"{name}: {len(docs):,} chunks, {n_tokens:,} tokens, {len(queries)} queries")

    all_vecs = np.concatenate(docs)
    cfg = IndexConfig(dim=all_vecs.shape[1], k_ivf=args.k_ivf, m_pq=args.m_pq)
    qpath = Path("data") / f"quantizer_{name.replace('/', '_')}_{args.markers}_{args.k_ivf}_{args.m_pq}.npz"
    if qpath.exists():
        quant = Quantizer.load(str(qpath))
    else:
        t = time.perf_counter()
        quant = Quantizer.train(all_vecs, cfg, verbose=True)
        qpath.parent.mkdir(exist_ok=True)
        quant.save(str(qpath))
        print(f"quantizer trained in {time.perf_counter() - t:.0f}s")

    if args.store == "cassandra":
        from smdb.store import CassandraStore
        store = CassandraStore(keyspace=args.keyspace)
    else:
        store = MemoryStore()
    scope = f"bench:{name}"
    cids, codes = quant.encode(all_vecs)
    token_centroids = cids.astype(np.int64)
    if int(store.partition_sizes(cfg, scope).sum()) == n_tokens:
        print("store already holds this corpus; skipping ingest")
    else:
        t = time.perf_counter()
        ofs = 0
        fresh = int(store.partition_sizes(cfg, scope).sum()) == 0
        for d, v in zip(doc_ids, docs):
            n = len(v)
            if n:
                if not fresh:          # partial earlier load: replace chunk by chunk
                    store.delete_doc(cfg, scope, d)
                store.write_doc(cfg, scope, d, cids[ofs:ofs + n], codes[ofs:ofs + n])
            ofs += n
        dt = time.perf_counter() - t
        print(f"ingest: {len(docs) / dt:,.0f} chunks/s ({dt:.1f}s, quantization excluded)")
    index = Index(store, quant)
    sizes = index.sizes(scope)
    print(f"partitions: {int((sizes > 0).sum())} non-empty of {cfg.k_ivf}, "
          f"median {int(np.median(sizes[sizes > 0]))} tokens, max {int(sizes.max())}")

    exact = ExactCorpus(doc_ids, docs)
    truth = [[d for d, _ in exact.search(q, 10)] for q in queries]
    oracle = [exact.oracle_centroids(q, token_centroids, 10) for q in queries]

    settings = [("exact", {})]
    settings += [("oracle", {})]
    settings += [("fixed", {"nprobe": n}) for n in (1, 2, 4, 8, 16)]
    settings += [("mass", {"budget": b, "tau": tau})
                 for tau in (0.02, 0.05, 0.1) for b in (4, 8, 16, 32, 64, 128)]

    rows = []
    for planner, params in settings:
        parts, toks, nd, ov, lat = [], [], [], [], []
        for i, q in enumerate(queries):
            if planner == "exact":
                got = truth[i]
                parts.append(0); toks.append(n_tokens); lat.append(0.0)
            else:
                kw = {"centroids": oracle[i]} if planner == "oracle" else {"planner": planner, **params}
                res, st = index.search(scope, q, 10, rerank=args.rerank, **kw)
                got = [r.doc_id for r in res]
                parts.append(st.partitions_read); toks.append(st.tokens_scored)
                lat.append(st.ms["total"])
            ov.append(overlap_at_k(got, truth[i], 10))
            if qrels is not None:
                nd.append(ndcg_at_k(got, qrels[i], 10))
        rows.append({"planner": planner, **params,
                     "partitions": statistics.mean(parts), "tokens": statistics.mean(toks),
                     "ndcg10": statistics.mean(nd) if nd else None,
                     "overlap10": statistics.mean(ov), "ms": statistics.median(lat)})

    print(f"\n{'planner':<8}{'params':<24}{'parts':>8}{'tokens':>10}{'nDCG@10':>9}{'ov@10':>8}{'ms':>8}")
    for r in rows:
        p = ", ".join(f"{k}={r[k]}" for k in ("nprobe", "budget", "tau") if k in r)
        nd = f"{r['ndcg10']:.4f}" if r["ndcg10"] is not None else "-"
        print(f"{r['planner']:<8}{p:<24}{r['partitions']:>8.1f}{r['tokens']:>10.0f}{nd:>9}"
              f"{r['overlap10']:>8.3f}{r['ms']:>8.1f}")

    key = "ndcg10" if qrels is not None else "overlap10"
    print(f"\nPartitions needed by `mass` to match each `fixed` setting on {key}:")
    for f in (r for r in rows if r["planner"] == "fixed"):
        ok = [r for r in rows if r["planner"] == "mass" and r[key] >= f[key]]
        if ok:
            b = min(ok, key=lambda r: r["partitions"])
            print(f"  fixed nprobe={f['nprobe']:<3} {f['partitions']:6.1f} parts -> mass "
                  f"{b['partitions']:6.1f} parts (budget={b['budget']}, tau={b['tau']}): "
                  f"{f['partitions'] / b['partitions']:.2f}x fewer")
        else:
            print(f"  fixed nprobe={f['nprobe']:<3} {f['partitions']:6.1f} parts -> no mass setting reached it")

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"bench_{name.replace('/', '_')}_{args.store}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": name, "store": args.store, "markers": args.markers,
                                "config": cfg.__dict__, "chunks": len(docs), "tokens": n_tokens,
                                "queries": len(queries), "rerank": args.rerank, "rows": rows}, indent=2))
    print(f"\nsaved {path}")


if __name__ == "__main__":
    main()
