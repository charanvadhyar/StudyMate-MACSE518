"""How many storage reads does a query need?  Fixed vs heuristic vs bound-driven reranking.

A query costs   partitions read (stage 1)  +  chunks fetched for rescoring (stage 2).
With the default rerank depth of 100, stage 2 dominates. This script measures, on
cached token vectors, how far that can be cut at equal quality by four families:

  fixed R     rescore the top-R stage-1 candidates                       (current behaviour)
  gap         rescore candidates within `delta` of the k-th stage-1 score (score-drop heuristic)
  patience    rescore in stage-1 order, stop when the top-k has not changed for `beta` fetches
  bound       rescore in order of an UPPER BOUND on each candidate's full score and stop as
              soon as no remaining candidate's bound can beat the current k-th best.

Bounds used by `bound`
  lower   a chunk's stage-1 score: MaxSim over the tokens read so far can only grow.
  upper   for query token q, a token in an unread partition c scores at most
              q.c + rho_c        hard: rho_c = largest residual norm stored in c
              q.c + z*sigma_c    soft: sigma_c = rms residual norm in c / sqrt(dim)
          so  UB(chunk) = sum_q max(best seen for the chunk, U_q),  U_q = max over unread c.
  rho_c and sigma_c are per-partition statistics that can be maintained at write time.

  python -u scripts/bench_reads.py --dataset beir/scifact/test --k-ivf 4096 --trainer faiss
  python -u scripts/bench_reads.py --synthetic --k-ivf 256          # pipeline check only

Needs the vectors and quantizer cached by scripts/bench.py (it builds them if missing).
"Quality" is nDCG@10 on the dataset labels and overlap@10 with the ranking obtained by
rescoring EVERY chunk (the best this index can do).
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
from smdb import planner as P                                       # noqa: E402
from smdb.eval import ndcg_at_k                                     # noqa: E402
from smdb.scorer import pq_scores                                   # noqa: E402

K = 10
CAP = 500   # never fetch more than this many chunks per query


def group_max(scores: np.ndarray, starts: np.ndarray) -> np.ndarray:
    return np.maximum.reduceat(scores, starts, axis=1)


def finish(fetched, lb, full):
    """Final top-k: fetched chunks by full score, then (if fewer than k) the rest by stage-1 score."""
    fetched = np.asarray(fetched, dtype=np.int64)
    top = fetched[np.argsort(-full[fetched], kind="stable")][:K]
    if len(top) < K:
        rest = [i for i in np.argsort(-lb, kind="stable") if i not in set(fetched.tolist())]
        top = np.concatenate([top, np.array(rest[:K - len(top)], dtype=np.int64)])
    return top


def run_policy(kind, param, lb, ub, full, ub_unseen):
    """Simulate one query. lb/ub/full are per-candidate arrays (stage-1 score, upper bound,
    full score). Returns (candidate indices of the final top-k, fetches, certified)."""
    n = len(lb)
    if kind == "fixed":
        order = np.argsort(-lb, kind="stable")
        got = order[:min(param, n)]
        return finish(got, lb, full), len(got), False
    if kind == "gap":
        order = np.argsort(-lb, kind="stable")
        kth = lb[order[min(K, n) - 1]]
        got = order[lb[order] >= kth - param][:CAP]
        return finish(got, lb, full), len(got), False
    if kind == "patience":
        order = np.argsort(-lb, kind="stable")[:CAP]
        best: list[int] = []
        still = 0
        used = 0
        for i in order:
            used += 1
            new = sorted(best + [int(i)], key=lambda j: -full[j])[:K]
            still = still + 1 if new == best else 0
            best = new
            if used >= K and still >= param:
                break
        return finish(best, lb, full), used, False
    if kind == "bound":
        order = np.argsort(-ub, kind="stable")[:CAP]
        fetched: list[int] = []
        theta = -np.inf
        for i in order:
            if len(fetched) >= K and ub[i] <= theta:
                break
            fetched.append(int(i))
            if len(fetched) >= K:
                theta = np.partition(full[fetched], -K)[-K]
        got = np.array(fetched)
        # everything not fetched has ub <= theta (order is by descending ub), unless we hit CAP
        stopped_early = len(fetched) < len(order) or len(order) == n
        certified = len(fetched) >= K and stopped_early and ub_unseen <= theta
        return finish(got, lb, full), len(fetched), bool(certified)
    raise ValueError(kind)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="beir/scifact/test")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--markers", default="legacy")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--k-ivf", type=int, default=4096)
    ap.add_argument("--m-pq", type=int, default=32)
    ap.add_argument("--trainer", choices=["sklearn", "faiss"], default="faiss")
    ap.add_argument("--nprobe", type=int, nargs="*", default=[1, 2])
    ap.add_argument("--max-queries", type=int)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    name = "synthetic" if args.synthetic else args.dataset
    doc_ids, docs, queries, qrels = (synthetic() if args.synthetic else
                                     load_beir(args.dataset, args.markers, args.device, args.max_queries))
    all_vecs = np.concatenate(docs)
    dim = all_vecs.shape[1]
    cfg = IndexConfig(dim=dim, k_ivf=args.k_ivf, m_pq=args.m_pq)
    qpath = Path("data") / (f"quantizer_{name.replace('/', '_')}_{args.markers}_{args.k_ivf}_{args.m_pq}"
                            f"{'' if args.trainer == 'sklearn' else '_' + args.trainer}.npz")
    if qpath.exists():
        quant = Quantizer.load(str(qpath))
    else:
        quant = Quantizer.train(all_vecs, cfg, trainer=args.trainer, verbose=True)
        qpath.parent.mkdir(exist_ok=True)
        quant.save(str(qpath))
    cids, codes = quant.encode(all_vecs)
    cids = cids.astype(np.int64)
    del all_vecs
    n_tok = len(cids)
    lens = np.array([len(v) for v in docs], dtype=np.int64)
    tok_doc = np.repeat(np.arange(len(docs)), lens)
    doc_starts = np.r_[0, np.cumsum(lens)[:-1]]
    nonempty = lens > 0
    print(f"{name}: {len(docs):,} chunks, {n_tok:,} tokens, {len(queries)} queries, k_ivf={args.k_ivf}")

    # per-partition statistics a store could maintain at write time
    cb_norm2 = (quant.codebooks ** 2).sum(axis=2)                              # [m, k_pq]
    res_norm2 = cb_norm2[np.arange(cfg.m_pq)[None, :], codes].sum(axis=1)      # [n_tok]
    sizes = np.bincount(cids, minlength=cfg.k_ivf)
    rho = np.zeros(cfg.k_ivf)
    np.maximum.at(rho, cids, np.sqrt(res_norm2))
    sigma = np.sqrt(np.bincount(cids, weights=res_norm2, minlength=cfg.k_ivf)
                    / np.maximum(sizes, 1) / dim)
    print(f"residual norm: max per partition median {np.median(rho[sizes > 0]):.3f}, "
          f"rms per-dimension sigma median {np.median(sigma[sizes > 0]):.4f}")

    # tokens grouped by partition, so a "partition read" is one contiguous slice
    order_c = np.argsort(cids, kind="stable")
    part_start = np.r_[0, np.cumsum(sizes)]

    policies = ([("fixed", r) for r in (0, 5, 10, 20, 30, 50, 100, 200)]
                + [("gap", d) for d in (0.25, 0.5, 1.0, 2.0, 3.0)]
                + [("patience", b) for b in (3, 5, 10, 20)]
                + [("bound", z) for z in ("hard", 4.0, 3.0, 2.0, 1.5, 1.0)])
    acc = {(p, kind, str(par)): {"parts": [], "fetch": [], "ndcg": [], "ov": [], "cert": []}
           for p in args.nprobe for kind, par in policies}
    slack = {p: [] for p in args.nprobe}
    gap10 = []
    ref_ndcg = []
    t0 = time.perf_counter()

    for qi, q in enumerate(queries):
        q = np.asarray(q, dtype=np.float32)
        S = quant.centroid_scores(q)                                           # [nq, k_ivf]
        luts = quant.residual_luts(q)
        tok = pq_scores(luts, codes) + S[:, cids]                              # every token, once
        full_all = np.where(nonempty, 0.0, -np.inf)
        full_all[nonempty] = group_max(tok, doc_starts[nonempty]).sum(axis=0)
        truth = np.argsort(-full_all, kind="stable")[:K]                       # best this index can do
        truth_ids = {int(i) for i in truth}
        gap10.append(float(full_all[truth[0]] - full_all[truth[-1]]))
        if qrels is not None:
            ref_ndcg.append(ndcg_at_k([doc_ids[i] for i in truth], qrels[qi], K))

        for p in args.nprobe:
            chosen = P.plan_fixed(S, sizes, nprobe=p)
            sel = np.concatenate([order_c[part_start[c]:part_start[c + 1]] for c in chosen])
            sel.sort()                                                         # back to chunk order
            d = tok_doc[sel]
            starts = np.flatnonzero(np.r_[True, d[1:] != d[:-1]])
            cand = d[starts]
            seen = group_max(tok[:, sel], starts)                              # [nq, n_cand]
            lb = seen.sum(axis=0)
            full = full_all[cand]
            unread = sizes > 0
            unread[chosen] = False
            for kind, par in policies:
                if kind == "bound":
                    margin = rho if par == "hard" else par * sigma
                    U = np.where(unread[None, :], S + margin[None, :], -np.inf).max(axis=1)
                    U = np.where(np.isfinite(U), U, -1e9)
                    ub = np.maximum(seen, U[:, None]).sum(axis=0)
                    ub_unseen = float(U.sum())
                    if par == "hard":
                        slack[p].append(float(np.mean(ub - full)))
                else:
                    ub, ub_unseen = lb, np.inf
                top, fetches, cert = run_policy(kind, par, lb, ub, full, ub_unseen)
                got = [int(cand[i]) for i in top]
                a = acc[(p, kind, str(par))]
                a["parts"].append(len(chosen)); a["fetch"].append(fetches); a["cert"].append(cert)
                a["ov"].append(len(truth_ids & set(got)) / K)
                if qrels is not None:
                    a["ndcg"].append(ndcg_at_k([doc_ids[i] for i in got], qrels[qi], K))
        if (qi + 1) % 50 == 0:
            print(f"  {qi + 1}/{len(queries)} queries, {time.perf_counter() - t0:.0f}s")

    rows = []
    for (p, kind, par), a in acc.items():
        rows.append({"nprobe": p, "policy": kind, "param": par,
                     "partitions": statistics.mean(a["parts"]), "fetches": statistics.mean(a["fetch"]),
                     "reads": statistics.mean(x + y for x, y in zip(a["parts"], a["fetch"])),
                     "ndcg10": statistics.mean(a["ndcg"]) if a["ndcg"] else None,
                     "overlap10": statistics.mean(a["ov"]),
                     "certified": statistics.mean(a["cert"])})
    if ref_ndcg:
        print(f"\nrescoring every chunk: nDCG@10 {statistics.mean(ref_ndcg):.4f}")
    print(f"score gap between rank 1 and rank {K}: {statistics.mean(gap10):.2f} on average")
    for p in args.nprobe:
        print(f"hard upper bound exceeds the true score by {statistics.mean(slack[p]):.2f} on average "
              f"at nprobe={p}  (it can only prune if this is small next to the gap above)")
    print(f"\n{'nprobe':>6} {'policy':<9}{'param':<7}{'parts':>7}{'fetch':>8}{'reads':>8}"
          f"{'nDCG@10':>9}{'ov@10':>8}{'certif':>8}")
    print("       (certif = share of queries whose top-k was proven complete; meaningful for bound=hard only)")
    for r in rows:
        nd = f"{r['ndcg10']:.4f}" if r["ndcg10"] is not None else "-"
        print(f"{r['nprobe']:>6} {r['policy']:<9}{r['param']:<7}{r['partitions']:>7.1f}{r['fetches']:>8.1f}"
              f"{r['reads']:>8.1f}{nd:>9}{r['overlap10']:>8.3f}{r['certified']:>8.2f}")

    key = "ndcg10" if qrels is not None else "overlap10"
    print(f"\nFewest total reads per family that keep {key} within 0.002 of fixed R=100:")
    for p in args.nprobe:
        target = next(r[key] for r in rows if r["nprobe"] == p and r["policy"] == "fixed"
                      and r["param"] == "100") - 0.002
        for kind in ("fixed", "gap", "patience", "bound"):
            ok = [r for r in rows if r["nprobe"] == p and r["policy"] == kind and r[key] >= target]
            if ok:
                b = min(ok, key=lambda r: r["reads"])
                print(f"  nprobe={p} {kind:<9} {b['reads']:7.1f} reads  (param {b['param']}, "
                      f"{key} {b[key]:.4f}, ov@10 {b['overlap10']:.3f})")
            else:
                print(f"  nprobe={p} {kind:<9} no setting reached it")
    print("  A family only matters if it beats the best `fixed` row here by a clear margin.")

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    path = out / f"reads_{name.replace('/', '_')}_k{args.k_ivf}_{args.trainer}_{datetime.now():%Y%m%d_%H%M%S}.json"
    path.write_text(json.dumps({"dataset": name, "k_ivf": args.k_ivf, "trainer": args.trainer,
                                "queries": len(queries), "rows": rows}, indent=2))
    print(f"\nsaved {path}")


if __name__ == "__main__":
    main()
