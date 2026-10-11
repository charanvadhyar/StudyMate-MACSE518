"""End-to-end benchmark of the index.

  python -u scripts/bench.py --dataset beir/scifact/test --k-ivf 4096 --trainer faiss
  python -u scripts/bench.py ... --postings ids --pool hierarchical     # compact layout
  python -u scripts/bench.py ... --model answerdotai/answerai-colbert-small-v1 --markers colbert
  python -u scripts/bench.py ... --store cassandra                      # same run on a live cluster
  python -u scripts/bench.py ... --sweep full                           # planner study (fixed vs mass vs oracle)
  python -u scripts/bench.py --synthetic --k-ivf 256                    # no model; pipeline check only

The default sweep varies partitions probed and rerank depth, and reports total storage
reads per query (partitions + chunks fetched) next to quality.

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
import dataclasses
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


def load_beir(name: str, markers: str, device: str, max_queries: int | None,
              model: str | None = None, augment: bool = False):
    import ir_datasets
    from tqdm import tqdm
    from smdb.encoder import DEFAULT_MODEL, ColbertEncoder, model_tag

    model = model or DEFAULT_MODEL
    tag = "" if model == DEFAULT_MODEL else "_" + model_tag(model)
    cache = Path("data") / f"{name.replace('/', '_')}{tag}_{markers}{'_aug' if augment else ''}.npz"
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
        enc = ColbertEncoder(model, device=device, markers=markers, augment_queries=augment)
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


def variant_tag(args) -> str:
    from smdb.encoder import DEFAULT_MODEL, model_tag
    parts = [f"k{args.k_ivf}", args.trainer, f"m{args.m_pq}", args.postings]
    if args.pool != "none":
        parts.append(f"{args.pool[:4]}{args.pool_factor if args.pool == 'hierarchical' else ''}")
    if (args.model or DEFAULT_MODEL) != DEFAULT_MODEL:
        parts.append(model_tag(args.model))
    if args.markers != "legacy":
        parts.append(args.markers)
    return "_".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--store", choices=["memory", "cassandra"], default="memory")
    ap.add_argument("--keyspace", default="smdb_bench")
    ap.add_argument("--port", type=int, default=9042)
    ap.add_argument("--container", help="Docker container name of that Cassandra; if given, the on-disk "
                                        "size of the keyspace's index tables is measured (use a fresh --keyspace)")
    ap.add_argument("--model", help="Stanford-format ColBERT checkpoint (default colbert-ir/colbertv2.0)")
    ap.add_argument("--markers", default="legacy", choices=["legacy", "colbert"])
    ap.add_argument("--augment", action="store_true", help="legacy markers only: [MASK]-pad queries")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--k-ivf", type=int, default=1024)
    ap.add_argument("--m-pq", type=int, default=32)
    ap.add_argument("--trainer", choices=["sklearn", "faiss"], default="sklearn",
                    help="k-means implementation for centroids and PQ codebooks")
    ap.add_argument("--postings", choices=["codes", "ids", "single"], default="codes",
                    help="ids = store PQ codes once (posting rows carry chunk ids only)")
    ap.add_argument("--pool", choices=["none", "hierarchical", "centroid"], default="none")
    ap.add_argument("--pool-factor", type=int, default=2)
    ap.add_argument("--sweep", choices=["quick", "full"], default="quick")
    ap.add_argument("--nprobes", type=int, nargs="*", default=[1, 2, 4])
    ap.add_argument("--reranks", type=int, nargs="*", default=[20, 50, 100])
    ap.add_argument("--rerank", type=int, default=100, help="rerank depth for --sweep full")
    ap.add_argument("--refine", type=float, nargs="*", default=[],
                    help="--postings single: also run with these refine slacks (see Index.search)")
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)      # show progress even when piped to a file

    from smdb.encoder import DEFAULT_MODEL, model_tag
    name = "synthetic" if args.synthetic else args.dataset
    doc_ids, docs, queries, qrels = (synthetic() if args.synthetic else
                                     load_beir(args.dataset, args.markers, args.device, args.max_queries,
                                               args.model, args.augment))
    n_tokens = sum(len(v) for v in docs)
    print(f"{name}: {len(docs):,} chunks, {n_tokens:,} tokens, {len(queries)} queries")

    all_vecs = np.concatenate(docs)
    mtag = "" if (args.model or DEFAULT_MODEL) == DEFAULT_MODEL else "_" + model_tag(args.model)
    qpath = Path("data") / (f"quantizer_{name.replace('/', '_')}{mtag}_{args.markers}_{args.k_ivf}_{args.m_pq}"
                            f"{'' if args.trainer == 'sklearn' else '_' + args.trainer}.npz")
    if qpath.exists():
        quant = Quantizer.load(str(qpath))
    else:
        t = time.perf_counter()
        quant = Quantizer.train(all_vecs, IndexConfig(dim=all_vecs.shape[1], k_ivf=args.k_ivf, m_pq=args.m_pq),
                                trainer=args.trainer, verbose=True)
        qpath.parent.mkdir(exist_ok=True)
        quant.save(str(qpath))
        print(f"quantizer trained in {time.perf_counter() - t:.0f}s")
    cfg = dataclasses.replace(quant.cfg, postings=args.postings)
    quant = Quantizer(cfg, quant.centroids, quant.codebooks)

    if args.store == "cassandra":
        from smdb.store import CassandraStore
        store = CassandraStore(port=args.port, keyspace=args.keyspace)
    else:
        store = MemoryStore()
    tag = variant_tag(args)
    scope = f"bench:{name}:{tag}"
    index = Index(store, quant, pool=args.pool, pool_factor=args.pool_factor)

    t = time.perf_counter()
    quantized = [(d, *index.quantize(v)) for d, v in zip(doc_ids, docs) if len(v)]
    t_quant = time.perf_counter() - t
    stored = sum(len(c) for _, c, _ in quantized)
    rows_post = sum(len(np.unique(c)) for _, c, _ in quantized)
    id_bytes = sum(len(d) for d, _, _ in quantized) / max(1, len(quantized))
    logical = (stored * (2 + cfg.m_pq) + (stored * cfg.m_pq if cfg.postings == "codes" else 0)
               + rows_post * id_bytes) / len(docs)
    print(f"layout {tag}: {stored / len(docs):.0f} vectors per chunk ({stored / n_tokens:.0%} of tokens), "
          f"about {logical:,.0f} bytes per chunk before Cassandra overhead "
          f"(pool + quantize {len(docs) / t_quant:,.0f} chunks/s)")
    if int(store.partition_sizes(cfg, scope).sum()) == stored:
        print("store already holds this corpus; skipping ingest")
    else:
        fresh = int(store.partition_sizes(cfg, scope).sum()) == 0
        t = time.perf_counter()
        for s0 in range(0, len(quantized), 256):
            batch = quantized[s0:s0 + 256]
            if not fresh:              # partial earlier load: replace chunk by chunk
                for d, _, _ in batch:
                    store.delete_doc(cfg, scope, d)
            store.write_docs(cfg, scope, batch)
        dt = time.perf_counter() - t
        print(f"ingest: {len(docs) / dt:,.0f} chunks/s ({dt:.1f}s, quantization excluded)")
    disk = None
    if args.store == "cassandra" and args.container:
        from smdb.diskusage import disk_bytes
        sizes_d = [disk_bytes(args.container, args.keyspace, t) for t in ("postings", "doc_tokens", "partition_stats")]
        if all(x is not None for x in sizes_d):
            disk = sum(sizes_d)
            print(f"on disk (postings + doc_tokens + stats, everything in keyspace {args.keyspace}): "
                  f"{disk / len(docs):,.0f} bytes per chunk ({disk / 1e6:,.1f} MB)")
    index._sizes.clear()
    sizes = index.sizes(scope)
    print(f"partitions: {int((sizes > 0).sum())} non-empty of {cfg.k_ivf}, "
          f"median {int(np.median(sizes[sizes > 0]))} vectors, max {int(sizes.max())}")

    exact = ExactCorpus(doc_ids, docs)
    truth = [[d for d, _ in exact.search(q, 10)] for q in queries]

    if args.sweep == "full":
        token_centroids = quant.encode(all_vecs)[0].astype(np.int64)
        oracle = [exact.oracle_centroids(q, token_centroids, 10) for q in queries]
        settings = [("exact", {}), ("oracle", {"rerank": args.rerank})]
        settings += [("fixed", {"nprobe": n, "rerank": args.rerank}) for n in (1, 2, 4, 8, 16)]
        settings += [("mass", {"budget": b, "tau": tau, "rerank": args.rerank})
                     for tau in (0.02, 0.05, 0.1) for b in (4, 8, 16, 32, 64, 128)]
    else:
        oracle = None
        settings = [("exact", {})]
        settings += [("fixed", {"nprobe": n, "rerank": r}) for n in args.nprobes for r in args.reranks]
        settings += [("fixed", {"nprobe": n, "rerank": r, "refine": f})
                     for f in args.refine for n in args.nprobes for r in args.reranks]
    del all_vecs

    rows = []
    for planner, params in settings:
        parts, fetch, nd, ov, lat, lat1, lat2, rowsf = [], [], [], [], [], [], [], []
        for i, q in enumerate(queries):
            if planner == "exact":
                got = truth[i]
                parts.append(0); fetch.append(0); lat.append(0.0); lat1.append(0.0); lat2.append(0.0); rowsf.append(0)
            else:
                kw = dict(params)
                if planner == "oracle":
                    kw["centroids"] = oracle[i]
                else:
                    kw["planner"] = planner
                res, st = index.search(scope, q, 10, **kw)
                got = [r.doc_id for r in res]
                parts.append(st.partitions_read); fetch.append(st.reranked)
                rowsf.append(st.rows_fetched)
                lat.append(st.ms["total"])
                lat1.append(st.ms.get("read_partitions", 0.0))      # stage 1: posting partition reads
                lat2.append(st.ms.get("read_docs", 0.0))            # stage 2: candidate fetch
            ov.append(overlap_at_k(got, truth[i], 10))
            if qrels is not None:
                nd.append(ndcg_at_k(got, qrels[i], 10))
        rows.append({"planner": planner, **params,
                     "partitions": statistics.mean(parts), "fetched": statistics.mean(fetch),
                     "reads": statistics.mean(a + b for a, b in zip(parts, fetch)),
                     "rows": statistics.mean(rowsf),
                     "ndcg10": statistics.mean(nd) if nd else None,
                     "overlap10": statistics.mean(ov), "ms": statistics.median(lat),
                     "ms_parts": statistics.median(lat1), "ms_fetch": statistics.median(lat2)})

    print(f"\n{'planner':<8}{'params':<32}{'parts':>7}{'fetch':>7}{'reads':>7}{'rows':>7}{'nDCG@10':>9}{'ov@10':>8}{'ms':>8}{'parts ms':>10}{'fetch ms':>10}")
    for r in rows:
        p = ", ".join(f"{k}={r[k]}" for k in ("nprobe", "budget", "tau", "rerank", "refine") if k in r)
        nd = f"{r['ndcg10']:.4f}" if r["ndcg10"] is not None else "-"
        print(f"{r['planner']:<8}{p:<32}{r['partitions']:>7.1f}{r['fetched']:>7.1f}{r['reads']:>7.1f}{r['rows']:>7.1f}{nd:>9}"
              f"{r['overlap10']:>8.3f}{r['ms']:>8.1f}{r['ms_parts']:>10.1f}{r['ms_fetch']:>10.1f}")

    if args.sweep == "full":
        key = "ndcg10" if qrels is not None else "overlap10"
        print(f"\nMatched cost: each `fixed` setting against the `mass` budget closest in partitions read ({key})")
        for f in (r for r in rows if r["planner"] == "fixed"):
            budgets = sorted({r["budget"] for r in rows if r["planner"] == "mass"})
            b = min(budgets, key=lambda x: abs(x - f["partitions"]))
            best = max((r for r in rows if r["planner"] == "mass" and r["budget"] == b), key=lambda r: r[key])
            print(f"  fixed nprobe={f['nprobe']:<3} {f['partitions']:6.1f} parts {f[key]:.4f}   |   "
                  f"mass budget={b:<4} {best['partitions']:6.1f} parts {best[key]:.4f} (tau={best['tau']})   "
                  f"diff {best[key] - f[key]:+.4f}")
        print("  Differences under about 0.01 are within noise for a few hundred queries.")

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"bench_{name.replace('/', '_')}_{args.store}_{tag}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": name, "store": args.store, "variant": tag,
                                "model": args.model or DEFAULT_MODEL, "markers": args.markers,
                                "config": dataclasses.asdict(cfg), "pool": args.pool,
                                "chunks": len(docs), "tokens": n_tokens, "vectors_stored": stored,
                                "bytes_per_chunk_logical": logical, "disk_bytes": disk, "queries": len(queries),
                                "sweep": args.sweep, "rows": rows}, indent=2))
    print(f"\nsaved {path}")


if __name__ == "__main__":
    main()
