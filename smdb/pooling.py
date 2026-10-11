"""Token pooling: store fewer vectors per chunk.

  pool_hierarchical   Clavie et al. 2024 (also what DataStax's ColBERT Live! uses): Ward-cluster
                      a chunk's token vectors into ceil(n / factor) groups and keep each
                      group's normalised mean.
  pool_by_centroid    Keep one vector per index centroid the chunk touches: tokens of the chunk
                      that fall in the same centroid are averaged. No extra clustering; the
                      reduction is whatever the index's own clustering gives.
"""
from __future__ import annotations

import numpy as np


def _normalised_means(vectors: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(labels, kind="stable")
    lab = labels[order]
    starts = np.flatnonzero(np.r_[True, lab[1:] != lab[:-1]])
    sums = np.add.reduceat(vectors[order], starts, axis=0)
    counts = np.diff(np.r_[starts, len(lab)])[:, None]
    means = sums / counts
    norms = np.linalg.norm(means, axis=1, keepdims=True)
    return (means / np.maximum(norms, 1e-9)).astype(np.float32), lab[starts]


def pool_hierarchical(vectors: np.ndarray, factor: int) -> np.ndarray:
    n = len(vectors)
    target = max(1, int(np.ceil(n / factor)))
    if factor <= 1 or n <= 2 or target >= n:
        return np.asarray(vectors, dtype=np.float32)
    from scipy.cluster.hierarchy import fcluster, linkage

    labels = fcluster(linkage(vectors, method="ward"), t=target, criterion="maxclust")
    return _normalised_means(np.asarray(vectors, dtype=np.float32), labels)[0]


def pool_by_centroid(vectors: np.ndarray, centroid_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Returns (pooled vectors, the centroid id each pooled vector stays assigned to)."""
    if len(vectors) == 0:
        return np.asarray(vectors, dtype=np.float32), np.asarray(centroid_ids)
    return _normalised_means(np.asarray(vectors, dtype=np.float32), np.asarray(centroid_ids))
