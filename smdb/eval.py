"""Evaluation helpers: exact MaxSim, ranking metrics and the planner oracle."""
from __future__ import annotations

import numpy as np


class ExactCorpus:
    """Uncompressed token vectors of a corpus, for ground truth."""

    def __init__(self, doc_ids: list[str], doc_vectors: list[np.ndarray]) -> None:
        self.doc_ids = doc_ids
        self.lens = np.array([v.shape[0] for v in doc_vectors], dtype=np.int64)
        self.vectors = np.concatenate(doc_vectors).astype(np.float32)
        self.starts = np.r_[0, np.cumsum(self.lens)[:-1]]
        self.tok_doc = np.repeat(np.arange(len(doc_ids)), self.lens)
        self._nonempty = self.lens > 0

    def _best(self, q: np.ndarray, want_arg: bool = False, block: int = 200_000):
        """Per (query token, doc): best token score, and optionally that token's index."""
        nq, nd = q.shape[0], len(self.doc_ids)
        best = np.full((nq, nd), -np.inf, dtype=np.float32)
        doc_starts = self.starts[self._nonempty]
        doc_idx = np.flatnonzero(self._nonempty)
        sim = np.concatenate([q @ self.vectors[s:s + block].T
                              for s in range(0, self.vectors.shape[0], block)], axis=1)
        best[:, doc_idx] = np.maximum.reduceat(sim, doc_starts, axis=1)
        if not want_arg:
            return best, None
        arg = np.zeros((nq, nd), dtype=np.int64)
        lens = self.lens[doc_idx]
        for i in range(nq):   # row by row keeps the temporaries small
            seg_max = np.repeat(best[i, doc_idx], lens)
            cand = np.where(sim[i] >= seg_max, np.arange(sim.shape[1]), sim.shape[1])
            arg[i, doc_idx] = np.minimum.reduceat(cand, doc_starts)
        return best, arg

    def search(self, q: np.ndarray, k: int = 10) -> list[tuple[str, float]]:
        best, _ = self._best(np.asarray(q, dtype=np.float32))
        scores = np.where(self._nonempty, best.sum(axis=0), -np.inf)
        top = np.argsort(-scores, kind="stable")[:k]
        return [(self.doc_ids[i], float(scores[i])) for i in top]

    def oracle_centroids(self, q: np.ndarray, token_centroids: np.ndarray, k: int = 10) -> list[int]:
        """Fewest posting partitions that give the true top-k chunks their exact score.

        token_centroids [n_tokens] is the centroid of every corpus token, in corpus
        order. For each (query token, top-k chunk) the chunk's best-matching token must
        be read, so the answer is the set of centroids holding those tokens. This is the
        reference point for planners: what a perfect planner would read to score the
        true top-k exactly. (With the rerank stage a planner can sometimes get the same
        top-k from fewer partitions, so it is not a strict lower bound.)
        """
        q = np.asarray(q, dtype=np.float32)
        best, arg = self._best(q, want_arg=True)
        scores = np.where(self._nonempty, best.sum(axis=0), -np.inf)
        top = np.argsort(-scores, kind="stable")[:k]
        return sorted({int(c) for c in token_centroids[arg[:, top]].ravel()})


def ndcg_at_k(retrieved: list[str], relevant: dict[str, int] | set[str], k: int = 10) -> float:
    rel = relevant if isinstance(relevant, dict) else {d: 1 for d in relevant}
    gains = [rel.get(d, 0) for d in retrieved[:k]]
    dcg = sum(g / np.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted((g for g in rel.values() if g > 0), reverse=True)[:k]
    idcg = sum(g / np.log2(i + 2) for i, g in enumerate(ideal))
    return float(dcg / idcg) if idcg > 0 else 0.0


def recall_at_k(retrieved: list[str], relevant, k: int) -> float:
    rel = {d for d, g in relevant.items() if g > 0} if isinstance(relevant, dict) else set(relevant)
    return len(set(retrieved[:k]) & rel) / len(rel) if rel else 0.0


def overlap_at_k(retrieved: list[str], truth: list[str], k: int) -> float:
    """Fraction of the exact top-k that the approximate search also returned."""
    return len(set(retrieved[:k]) & set(truth[:k])) / max(1, min(k, len(truth)))
