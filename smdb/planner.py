"""Probe planners: decide which posting partitions to read for one query.

Input for every planner:
  scores  [nq, k]  dot product of each query token with each centroid
  sizes   [k]      tokens stored per centroid for this scope (0 = empty partition)

Output: centroid ids, most valuable first.

  fixed  Baseline (PLAID-style). Every query token takes its own top-`nprobe`
         centroids; the union is read. Cost grows with the number of query tokens.

  mass   Joint budget. Each query token spreads one unit of probability mass over
         the centroids, softmax(score / tau). A partition's value is the mass it
         collects from all query tokens, optionally divided by its read cost
         (size ** alpha). The best `budget` partitions are read. Partitions useful
         to several tokens are preferred, and tokens with a flat score profile
         (little evidence about where their match lives) get little say.

`mass` is a heuristic under evaluation, not a proven improvement: compare it with
`fixed` at equal partitions read (scripts/bench.py does this).
"""
from __future__ import annotations

import numpy as np

PLANNERS = ("fixed", "mass")


def _mask_empty(scores: np.ndarray, sizes: np.ndarray | None) -> np.ndarray:
    if sizes is None:
        return scores
    return np.where(sizes[None, :] > 0, scores, -np.inf)


def plan_fixed(scores: np.ndarray, sizes: np.ndarray | None = None, nprobe: int = 4) -> list[int]:
    """Union of each token's top-`nprobe` non-empty centroids, ordered by best score."""
    s = _mask_empty(np.asarray(scores, dtype=np.float32), sizes)
    k = s.shape[1]
    nprobe = max(1, min(nprobe, k))
    top = np.argpartition(-s, nprobe - 1, axis=1)[:, :nprobe]
    best: dict[int, float] = {}
    for q in range(s.shape[0]):
        for c in top[q]:
            v = float(s[q, c])
            if np.isfinite(v) and v > best.get(int(c), -np.inf):
                best[int(c)] = v
    return sorted(best, key=best.get, reverse=True)


def partition_mass(scores: np.ndarray, sizes: np.ndarray | None = None, tau: float = 0.05,
                   token_weights: np.ndarray | None = None) -> np.ndarray:
    """[k] probability mass each centroid collects from the query tokens."""
    s = _mask_empty(np.asarray(scores, dtype=np.float64), sizes)
    row_max = s.max(axis=1, keepdims=True)
    row_max = np.where(np.isfinite(row_max), row_max, 0.0)
    p = np.exp((s - row_max) / tau)                 # exp(-inf) = 0 for empty partitions
    z = p.sum(axis=1, keepdims=True)
    p = np.divide(p, z, out=np.zeros_like(p), where=z > 0)
    if token_weights is not None:
        p = p * np.asarray(token_weights, dtype=np.float64)[:, None]
    return p.sum(axis=0)


def plan_mass(scores: np.ndarray, sizes: np.ndarray | None = None, budget: int = 16,
              tau: float = 0.05, alpha: float = 0.0, max_tokens: int | None = None,
              token_weights: np.ndarray | None = None) -> list[int]:
    """Top-`budget` partitions by collected mass per unit cost.

    alpha       0 ranks by mass alone; 1 ranks by mass per stored token.
    max_tokens  optional cap on the total tokens in the chosen partitions.
    """
    mass = partition_mass(scores, sizes, tau, token_weights)
    value = mass.copy()
    if sizes is not None and alpha > 0:
        value = value / np.maximum(sizes, 1).astype(np.float64) ** alpha
    order = np.argsort(-value, kind="stable")
    chosen: list[int] = []
    used = 0
    for c in order:
        if len(chosen) >= budget or mass[c] <= 0:
            break
        if max_tokens is not None and sizes is not None:
            if chosen and used + int(sizes[c]) > max_tokens:
                continue
            used += int(sizes[c])
        chosen.append(int(c))
    return chosen


def plan(name: str, scores: np.ndarray, sizes: np.ndarray | None = None, **params) -> list[int]:
    if name == "fixed":
        return plan_fixed(scores, sizes, nprobe=int(params.get("nprobe", 4)))
    if name == "mass":
        return plan_mass(scores, sizes,
                         budget=int(params.get("budget", 16)),
                         tau=float(params.get("tau", 0.05)),
                         alpha=float(params.get("alpha", 0.0)),
                         max_tokens=params.get("max_tokens"),
                         token_weights=params.get("token_weights"))
    raise ValueError(f"unknown planner {name!r}; expected one of {PLANNERS}")
