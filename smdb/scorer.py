"""Scoring: PQ lookup kernel plus per-chunk MaxSim aggregation.

Uses the Rust AVX2 kernel from colvec (kernel/, module `colvec_kernel`) when it is
installed and k_pq == 256; otherwise a NumPy fallback with identical results.
"""
from __future__ import annotations

import numpy as np

try:  # built with `maturin develop --release` inside kernel/
    import colvec_kernel as _kernel
except Exception:  # pragma: no cover - depends on the local build
    _kernel = None

HAVE_KERNEL = _kernel is not None


def pq_scores_numpy(luts: np.ndarray, codes: np.ndarray) -> np.ndarray:
    nq, m_pq, _ = luts.shape
    out = np.zeros((nq, codes.shape[0]), dtype=np.float32)
    for m in range(m_pq):
        out += luts[:, m, :][:, codes[:, m]]
    return out


def pq_scores(luts: np.ndarray, codes: np.ndarray, use_kernel: bool = True) -> np.ndarray:
    """luts [nq, m_pq, k_pq] float32, codes [n, m_pq] uint8 -> residual scores [nq, n]."""
    if codes.shape[0] == 0:
        return np.zeros((luts.shape[0], 0), dtype=np.float32)
    if use_kernel and _kernel is not None and luts.shape[2] == 256:
        return _kernel.apply_pq_lookups(np.ascontiguousarray(luts, dtype=np.float32),
                                        np.ascontiguousarray(codes.T))
    return pq_scores_numpy(luts, codes)


def maxsim_by_group(token_scores: np.ndarray, group: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Late-interaction score per group (chunk).

    token_scores [nq, n]; group [n] integer id of the chunk each token belongs to.
    Returns (group ids [g], scores [g]) where score = sum over query tokens of the
    best-matching token of that chunk among the n tokens given.
    """
    if group.shape[0] == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    order = np.argsort(group, kind="stable")
    g = group[order]
    starts = np.flatnonzero(np.r_[True, g[1:] != g[:-1]])
    best = np.maximum.reduceat(token_scores[:, order], starts, axis=1)   # [nq, groups]
    return g[starts], best.sum(axis=0)
