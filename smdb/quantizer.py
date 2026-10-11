"""IVF centroids + residual product quantizer.

Ported from colvec (quantization/residual_pq_build.py and pq_train.py):
a token vector v is stored as (centroid id c, PQ code of the residual v - centroid[c]).
At query time   score(q, v) ~= q . centroid[c] + sum_m lut[q, m, code_m].
"""
from __future__ import annotations

import io

import numpy as np

from .config import IndexConfig


def _nearest(x: np.ndarray, centers: np.ndarray, batch: int = 50_000) -> np.ndarray:
    """Index of the nearest center (squared L2) for every row of x."""
    out = np.empty(x.shape[0], dtype=np.int64)
    c_sq = (centers ** 2).sum(axis=1)[None, :]
    for s in range(0, x.shape[0], batch):
        b = x[s:s + batch]
        d = (b ** 2).sum(axis=1, keepdims=True) + c_sq - 2.0 * (b @ centers.T)
        out[s:s + batch] = d.argmin(axis=1)
    return out


class Quantizer:
    def __init__(self, cfg: IndexConfig, centroids: np.ndarray, codebooks: np.ndarray):
        centroids = np.ascontiguousarray(centroids, dtype=np.float32)
        codebooks = np.ascontiguousarray(codebooks, dtype=np.float32)
        sub = cfg.dim // cfg.m_pq
        if centroids.shape != (cfg.k_ivf, cfg.dim):
            raise ValueError(f"centroids shape {centroids.shape} != {(cfg.k_ivf, cfg.dim)}")
        if codebooks.shape != (cfg.m_pq, cfg.k_pq, sub):
            raise ValueError(f"codebooks shape {codebooks.shape} != {(cfg.m_pq, cfg.k_pq, sub)}")
        self.cfg = cfg
        self.centroids = centroids
        self.codebooks = codebooks
        self._sub = sub

    # ---------------------------------------------------------------- training
    @staticmethod
    def train(vectors: np.ndarray, cfg: IndexConfig, sample_size: int | None = None,
              seed: int = 42, n_init: int = 3, max_iter: int = 100,
              trainer: str = "sklearn", verbose: bool = False) -> "Quantizer":
        """Train centroids and PQ codebooks.

        trainer="sklearn"  MiniBatchKMeans, as in colvec. Default sample: 200,000 vectors.
        trainer="faiss"    full k-means from FAISS (needs `pip install faiss-cpu`).
                           Default sample: up to 256 vectors per centroid, FAISS's own rule.
        """
        if trainer not in ("sklearn", "faiss"):
            raise ValueError("trainer must be 'sklearn' or 'faiss'")
        vectors = np.asarray(vectors, dtype=np.float32)
        n = vectors.shape[0]
        if n < max(cfg.k_ivf, cfg.k_pq):
            raise ValueError(f"need at least {max(cfg.k_ivf, cfg.k_pq)} training vectors, got {n}")
        if sample_size is None:
            sample_size = 200_000 if trainer == "sklearn" else max(200_000, 256 * cfg.k_ivf)
        rng = np.random.default_rng(seed)
        sample = vectors if n <= sample_size else vectors[rng.choice(n, sample_size, replace=False)]
        sample = np.ascontiguousarray(sample)
        sub = cfg.dim // cfg.m_pq
        if verbose:
            print(f"[quantizer] {trainer} k-means: {cfg.k_ivf} centroids on {len(sample):,} vectors")

        if trainer == "faiss":
            import faiss

            km = faiss.Kmeans(cfg.dim, cfg.k_ivf, niter=25, nredo=1, seed=seed, verbose=False)
            km.train(sample)
            centroids = np.array(km.centroids, dtype=np.float32).reshape(cfg.k_ivf, cfg.dim)
            residuals = np.ascontiguousarray(sample - centroids[_nearest(sample, centroids)])
            pq = faiss.ProductQuantizer(cfg.dim, cfg.m_pq, int(np.log2(cfg.k_pq)))
            if 2 ** pq.nbits != cfg.k_pq:
                raise ValueError("the faiss trainer needs k_pq to be a power of two")
            pq.cp.seed = seed
            pq.train(residuals)
            codebooks = faiss.vector_to_array(pq.centroids).reshape(cfg.m_pq, cfg.k_pq, sub).copy()
        else:
            from sklearn.cluster import MiniBatchKMeans

            km = MiniBatchKMeans(n_clusters=cfg.k_ivf, batch_size=4096, n_init=n_init,
                                 max_iter=max_iter, random_state=seed)
            km.fit(sample)
            centroids = km.cluster_centers_.astype(np.float32)
            residuals = sample - centroids[_nearest(sample, centroids)]
            codebooks = np.zeros((cfg.m_pq, cfg.k_pq, sub), dtype=np.float32)
            for m in range(cfg.m_pq):
                km = MiniBatchKMeans(n_clusters=cfg.k_pq, batch_size=4096, n_init=n_init,
                                     max_iter=max_iter, random_state=seed + 1 + m)
                km.fit(residuals[:, m * sub:(m + 1) * sub])
                codebooks[m] = km.cluster_centers_
        if verbose:
            print(f"[quantizer] PQ: {cfg.m_pq} codebooks x {cfg.k_pq} entries trained")
        return Quantizer(cfg, centroids, codebooks)

    # ---------------------------------------------------------------- encoding
    def encode(self, vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """vectors [n, dim] -> (centroid ids uint16 [n], residual PQ codes uint8 [n, m_pq])."""
        vectors = np.asarray(vectors, dtype=np.float32)
        cids = _nearest(vectors, self.centroids)
        residuals = vectors - self.centroids[cids]
        codes = np.empty((vectors.shape[0], self.cfg.m_pq), dtype=np.uint8)
        s = self._sub
        for m in range(self.cfg.m_pq):
            codes[:, m] = _nearest(residuals[:, m * s:(m + 1) * s], self.codebooks[m])
        return cids.astype(np.uint16), codes

    def encode_assigned(self, vectors: np.ndarray, cids: np.ndarray) -> np.ndarray:
        """PQ codes relative to GIVEN centroid ids (used after pooling by centroid)."""
        vectors = np.asarray(vectors, dtype=np.float32)
        residuals = vectors - self.centroids[np.asarray(cids, dtype=np.int64)]
        codes = np.empty((vectors.shape[0], self.cfg.m_pq), dtype=np.uint8)
        s = self._sub
        for m in range(self.cfg.m_pq):
            codes[:, m] = _nearest(residuals[:, m * s:(m + 1) * s], self.codebooks[m])
        return codes

    def decode(self, cids: np.ndarray, codes: np.ndarray) -> np.ndarray:
        """Approximate reconstruction, for tests and diagnostics."""
        out = self.centroids[np.asarray(cids, dtype=np.int64)].copy()
        s = self._sub
        for m in range(self.cfg.m_pq):
            out[:, m * s:(m + 1) * s] += self.codebooks[m][codes[:, m]]
        return out

    # ------------------------------------------------------------- query side
    def centroid_scores(self, q: np.ndarray) -> np.ndarray:
        """[nq, dim] -> [nq, k_ivf] dot products of query tokens with centroids."""
        return np.asarray(q, dtype=np.float32) @ self.centroids.T

    def residual_luts(self, q: np.ndarray) -> np.ndarray:
        """[nq, dim] -> [nq, m_pq, k_pq] lookup tables for the residual term."""
        q = np.asarray(q, dtype=np.float32)
        qc = q.reshape(q.shape[0], self.cfg.m_pq, self._sub)
        return np.ascontiguousarray(np.einsum("qmd,mkd->qmk", qc, self.codebooks), dtype=np.float32)

    # ------------------------------------------------------------ persistence
    def to_bytes(self) -> tuple[bytes, bytes]:
        return self.centroids.tobytes(), self.codebooks.tobytes()

    @staticmethod
    def from_bytes(cfg: IndexConfig, centroids: bytes, codebooks: bytes) -> "Quantizer":
        sub = cfg.dim // cfg.m_pq
        c = np.frombuffer(centroids, dtype=np.float32).reshape(cfg.k_ivf, cfg.dim)
        b = np.frombuffer(codebooks, dtype=np.float32).reshape(cfg.m_pq, cfg.k_pq, sub)
        return Quantizer(cfg, c.copy(), b.copy())

    def save(self, path: str) -> None:
        np.savez(path, config=np.array(self.cfg.to_json()), centroids=self.centroids,
                 codebooks=self.codebooks)

    @staticmethod
    def load(path: str) -> "Quantizer":
        with np.load(path, allow_pickle=False) as z:
            cfg = IndexConfig.from_json(str(z["config"]))
            return Quantizer(cfg, z["centroids"], z["codebooks"])

    def __eq__(self, other) -> bool:
        return (isinstance(other, Quantizer) and self.cfg == other.cfg
                and np.array_equal(self.centroids, other.centroids)
                and np.array_equal(self.codebooks, other.codebooks))
