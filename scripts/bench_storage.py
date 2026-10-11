"""How few vectors (and bytes) per chunk can the index store before quality drops?

Every representation below is scored exhaustively (every stored vector of every chunk),
so the numbers show what the REPRESENTATION can do, independent of probing or reranking.

  exact            uncompressed token vectors (float32)                 quality ceiling
  full   m=..      every token: centroid id + m-byte PQ code            what smdb stores today
  cpool  m=..      one vector per (chunk, centroid): tokens of a chunk that fall in the same
                   centroid are averaged, then stored as that centroid id + PQ code.
                   Uses the index's own clustering as the pooling rule; no extra clustering.
  hpool f m=..     token pooling (Clavie et al. 2024): Ward-cluster each chunk's tokens into
                   n/f groups, average, then quantize as usual.        published baseline
  centroid-only    a chunk is just its set of centroid ids (no residual codes at all).

Bytes per chunk assume each vector is stored ONCE (centroid id 2 bytes + code). smdb
currently stores codes twice (postings and doc_tokens); see the note printed at the end.

  python -u scripts/bench_storage.py --dataset beir/scifact/test --k-ivf 4096 --trainer faiss
  python -u scripts/bench_storage.py --synthetic --k-ivf 256 --trainer sklearn    # pipeline check
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
from smdb import IndexConfig, Quantizer                             # noqa: E402
from smdb.eval import ExactCorpus, ndcg_at_k, overlap_at_k          # noqa: E402
from smdb.quantizer import _nearest                                 # noqa: E402
from smdb.scorer import pq_scores                                   # noqa: E402

K = 10


def train_pq(residuals: np.ndarray, m: int, trainer: str, seed: int = 42) -> np.ndarray:
    """PQ codebooks [m, 256, dim/m] for residuals, with the centroids kept fixed."""
    dim = residuals.shape[1]
    sub = dim // m
    rng = np.random.default_rng(seed)
    sample = residuals if len(residuals) <= 200_000 else residuals[rng.choice(len(residuals), 200_000, replace=False)]
    sample = np.ascontiguousarray(sample, dtype=np.float32)
    if trainer == "faiss":
        import faiss
        pq = faiss.ProductQuantizer(dim, m, 8)
        pq.cp.seed = seed
        pq.train(sample)
        return faiss.vector_to_array(pq.centroids).reshape(m, 256, sub).copy()
    from sklearn.cluster import MiniBatchKMeans
    books = np.zeros((m, 256, sub), dtype=np.float32)
    for j in range(m):
        km = MiniBatchKMeans(n_clusters=256, batch_size=4096, n_init=1, max_iter=50, random_state=seed + j)
        km.fit(sample[:, j * sub:(j + 1) * sub])
        books[j] = km.cluster_centers_
    return books


def encode_fixed(quant: Quantizer, vecs: np.ndarray, cids: np.ndarray) -> np.ndarray:
    """PQ codes of vecs relative to the GIVEN centroid ids (not the nearest ones)."""
    res = vecs - quant.centroids[cids]
    sub = quant.cfg.dim // quant.cfg.m_pq
    codes = np.empty((len(vecs), quant.cfg.m_pq), dtype=np.uint8)
    for j in range(quant.cfg.m_pq):
        codes[:, j] = _nearest(res[:, j * sub:(j + 1) * sub], quant.codebooks[j])
    return codes


def group_mean(vecs: np.ndarray, key: np.ndarray):
    """Mean of rows sharing a key (key must be sorted). Returns (means, first index of each group)."""
    starts = np.flatnonzero(np.r_[True, key[1:] != key[:-1]])
    sums = np.add.reduceat(vecs, starts, axis=0)
    counts = np.diff(np.r_[starts, len(key)])[:, None]
    means = sums / counts
    norms = np.linalg.norm(means, axis=1, keepdims=True)
    return (means / np.maximum(norms, 1e-9)).astype(np.float32), starts


def hpool(docs: list[np.ndarray], factor: int):
    """Hierarchical token pooling per chunk. Returns (vectors, chunk index per vector)."""
    from scipy.cluster.hierarchy import fcluster, linkage

    out, owner = [], []
    for i, v in enumerate(docs):
        n = len(v)
        if n == 0:
            continue
        target = max(1, int(np.ceil(n / factor)))
        if n <= 2 or target >= n:
            out.append(v); owner.append(np.full(n, i)); continue
        labels = fcluster(linkage(v, method="ward"), t=target, criterion="maxclust")
        order = np.argsort(labels, kind="stable")
        means, _ = group_mean(v[order], labels[order])
        out.append(means); owner.append(np.full(len(means), i))
    return np.concatenate(out), np.concatenate(owner)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--markers", default="legacy")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--k-ivf", type=int, default=4096)
    ap.add_argument("--trainer", choices=["sklearn", "faiss"], default="faiss")
    ap.add_argument("--m", type=int, nargs="*", default=[32, 16], help="PQ code sizes in bytes to try")
    ap.add_argument("--hpool", type=int, nargs="*", default=[2, 3], help="token pooling factors to try")
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    name = "synthetic" if args.synthetic else args.dataset
    doc_ids, docs, queries, qrels = (synthetic() if args.synthetic else
                                     load_beir(args.dataset, args.markers, args.device, args.max_queries))
    all_vecs = np.concatenate(docs)
    dim = all_vecs.shape[1]
    n_docs = len(docs)
    lens = np.array([len(v) for v in docs], dtype=np.int64)
    tok_doc = np.repeat(np.arange(n_docs), lens)
    qpath = Path("data") / (f"quantizer_{name.replace('/', '_')}_{args.markers}_{args.k_ivf}_32"
                            f"{'' if args.trainer == 'sklearn' else '_' + args.trainer}.npz")
    if qpath.exists():
        base = Quantizer.load(str(qpath))
    else:
        base = Quantizer.train(all_vecs, IndexConfig(dim=dim, k_ivf=args.k_ivf, m_pq=32),
                               trainer=args.trainer, verbose=True)
        qpath.parent.mkdir(exist_ok=True)
        base.save(str(qpath))
    cids = _nearest(all_vecs, base.centroids)
    print(f"{name}: {n_docs:,} chunks, {len(cids):,} tokens ({len(cids) / n_docs:.0f} per chunk), "
          f"{len(queries)} queries, k_ivf={args.k_ivf}")

    quants = {32: base}
    for m in args.m:
        if m not in quants:
            books = train_pq(all_vecs - base.centroids[cids], m, args.trainer)
            quants[m] = Quantizer(IndexConfig(dim=dim, k_ivf=args.k_ivf, m_pq=m), base.centroids, books)
            print(f"trained PQ with m={m}")

    # ---- build the representations: (label, m or None, cids, vectors-or-None, chunk index) ----
    reps = []
    for m in args.m:
        reps.append((f"full m={m}", m, cids, all_vecs, tok_doc))
    key = tok_doc * args.k_ivf + cids                       # (chunk, centroid) pairs
    order = np.argsort(key, kind="stable")
    pooled, starts = group_mean(all_vecs[order], key[order])
    p_doc, p_cid = tok_doc[order][starts], cids[order][starts]
    print(f"cpool: {len(p_cid):,} vectors ({len(p_cid) / len(cids):.0%} of the tokens)")
    for m in args.m:
        reps.append((f"cpool m={m}", m, p_cid, pooled, p_doc))
    for f in args.hpool:
        t = time.perf_counter()
        hv, hd = hpool(docs, f)
        print(f"hpool {f}: {len(hv):,} vectors, pooled in {time.perf_counter() - t:.0f}s")
        reps.append((f"hpool {f} m={args.m[0]}", args.m[0], _nearest(hv, base.centroids), hv, hd))
    reps.append(("centroid-only", None, p_cid, None, p_doc))

    built = []
    for label, m, c, v, d in reps:
        codes = encode_fixed(quants[m], v, c) if m is not None else None
        starts_d = np.flatnonzero(np.r_[True, d[1:] != d[:-1]])
        built.append((label, m, c, codes, d[starts_d], starts_d,
                      len(c) * (2 + (m or 0)) / n_docs, len(c) / n_docs))
    del all_vecs, pooled

    exact = ExactCorpus(doc_ids, docs)
    truth = [[d for d, _ in exact.search(q, K)] for q in queries]
    rows = [{"representation": "exact (float32)", "vectors_per_chunk": float(lens.mean()),
             "bytes_per_chunk": float(lens.mean()) * dim * 4,
             "ndcg10": statistics.mean(ndcg_at_k(t, r, K) for t, r in zip(truth, qrels)) if qrels else None,
             "overlap10": 1.0}]
    for label, m, c, codes, owners, starts_d, nbytes, nvec in built:
        t = time.perf_counter()
        nd, ov = [], []
        for qi, q in enumerate(queries):
            q = np.asarray(q, dtype=np.float32)
            s = quants[32].centroid_scores(q)[:, c]
            if codes is not None:
                s = s + pq_scores(quants[m].residual_luts(q), codes)
            score = np.full(n_docs, -np.inf)
            score[owners] = np.maximum.reduceat(s, starts_d, axis=1).sum(axis=0)
            got = [doc_ids[i] for i in np.argsort(-score, kind="stable")[:K]]
            ov.append(overlap_at_k(got, truth[qi], K))
            if qrels is not None:
                nd.append(ndcg_at_k(got, qrels[qi], K))
        rows.append({"representation": label, "vectors_per_chunk": nvec, "bytes_per_chunk": nbytes,
                     "ndcg10": statistics.mean(nd) if nd else None, "overlap10": statistics.mean(ov)})
        print(f"  {label}: done in {time.perf_counter() - t:.0f}s")

    print(f"\n{'representation':<20}{'vec/chunk':>10}{'bytes/chunk':>13}{'nDCG@10':>9}{'ov@10':>8}")
    for r in rows:
        nd = f"{r['ndcg10']:.4f}" if r["ndcg10"] is not None else "-"
        print(f"{r['representation']:<20}{r['vectors_per_chunk']:>10.1f}{r['bytes_per_chunk']:>13,.0f}{nd:>9}{r['overlap10']:>8.3f}")
    print("\nFor scale: one 384-dim float vector (MiniLM in SAI) is 1,536 bytes per chunk; a 768-dim one is 3,072.")
    print("smdb today stores `full m=32` twice (postings + doc_tokens), so about double that row.")

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"storage_{name.replace('/', '_')}_k{args.k_ivf}_{args.trainer}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": name, "k_ivf": args.k_ivf, "trainer": args.trainer,
                                "queries": len(queries), "rows": rows}, indent=2))
    print(f"saved {path}")


if __name__ == "__main__":
    main()
