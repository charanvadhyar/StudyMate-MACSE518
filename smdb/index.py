"""Index: ingest chunks and answer late-interaction queries.

Query path
  1. score the query tokens against all centroids                    (memory)
  2. planner picks which posting partitions to read                  (memory)
  3. read those partitions, score their PQ codes, keep the best R chunks
  4. read the full token codes of those R chunks and rescore         (rerank)
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from . import planner as planners
from .quantizer import Quantizer
from .scorer import maxsim_by_group, pq_scores
from .store.base import Store


@dataclass
class SearchResult:
    doc_id: str
    score: float


@dataclass
class SearchStats:
    planner: str = ""
    partitions_read: int = 0       # posting partitions requested from the store
    partitions_nonempty: int = 0
    tokens_scored: int = 0         # stage-1 token codes scored
    candidates: int = 0            # distinct chunks seen in stage 1
    reranked: int = 0              # chunks whose full codes were fetched
    ms: dict = field(default_factory=dict)


class Index:
    def __init__(self, store: Store, quantizer: Quantizer, encoder=None,
                 sizes_ttl_s: float = 5.0, use_kernel: bool = True) -> None:
        self.store = store
        self.q = quantizer
        self.cfg = quantizer.cfg
        self.encoder = encoder
        self.use_kernel = use_kernel
        self._sizes_ttl = sizes_ttl_s
        self._sizes: dict[str, tuple[float, np.ndarray]] = {}

    @staticmethod
    def open(store: Store, index_id: str = "default", encoder=None, **kw) -> "Index":
        q = store.load_quantizer(index_id)
        if q is None:
            raise LookupError(f"no quantizer stored under index_id={index_id!r}; train one first")
        return Index(store, q, encoder, **kw)

    # ----------------------------------------------------------------- ingest
    def add(self, scope: str, doc_id: str, vectors: np.ndarray, replace: bool = True) -> int:
        """Index one chunk from its token vectors [n, dim]. Returns tokens stored.

        replace=False skips the existence check; use it only for bulk loads where
        each doc_id is written once.
        """
        vectors = np.asarray(vectors, dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != self.cfg.dim:
            raise ValueError(f"vectors must be [n, {self.cfg.dim}], got {vectors.shape}")
        if replace:
            self.store.delete_doc(self.cfg, scope, doc_id)
        if vectors.shape[0] == 0:
            return 0
        cids, codes = self.q.encode(vectors)
        self.store.write_doc(self.cfg, scope, doc_id, cids, codes)
        self._sizes.pop(scope, None)
        return int(vectors.shape[0])

    def add_text(self, scope: str, doc_id: str, text: str, replace: bool = True) -> int:
        self._need_encoder()
        return self.add(scope, doc_id, self.encoder.encode_doc(text), replace)

    def delete(self, scope: str, doc_id: str) -> bool:
        self._sizes.pop(scope, None)
        return self.store.delete_doc(self.cfg, scope, doc_id)

    # ----------------------------------------------------------------- search
    def sizes(self, scope: str) -> np.ndarray:
        hit = self._sizes.get(scope)
        now = time.monotonic()
        if hit is not None and now - hit[0] < self._sizes_ttl:
            return hit[1]
        s = self.store.partition_sizes(self.cfg, scope)
        self._sizes[scope] = (now, s)
        return s

    def search_text(self, scope: str, query: str, k: int = 10, **kw):
        self._need_encoder()
        return self.search(scope, self.encoder.encode_query(query), k, **kw)

    def search(self, scope: str, query_vectors: np.ndarray, k: int = 10,
               planner: str = "mass", rerank: int = 100, centroids: list[int] | None = None,
               **planner_params) -> tuple[list[SearchResult], SearchStats]:
        """Top-k chunks for the query token vectors [nq, dim].

        planner / planner_params  see smdb.planner (fixed: nprobe; mass: budget, tau, alpha)
        rerank      how many stage-1 candidates get the full-token rescoring (0 = none)
        centroids   bypass the planner and read exactly these partitions (for experiments)
        """
        st = SearchStats(planner="given" if centroids is not None else planner)
        t0 = time.perf_counter()
        qv = np.asarray(query_vectors, dtype=np.float32)
        cscores = self.q.centroid_scores(qv)                      # [nq, k_ivf]
        luts = self.q.residual_luts(qv)                           # [nq, m_pq, k_pq]
        if centroids is None:
            centroids = planners.plan(planner, cscores, self.sizes(scope), **planner_params)
        t1 = time.perf_counter()

        parts = self.store.read_partitions(self.cfg, scope, list(centroids))
        t2 = time.perf_counter()
        st.partitions_read = len(centroids) * self.cfg.n_buckets
        st.partitions_nonempty = sum(1 for p in parts if p.codes.shape[0])

        # ---- stage 1: approximate MaxSim from the tokens that were read ----
        doc_index: dict[str, int] = {}
        row_doc: list[int] = []
        for p in parts:
            for d in p.doc_ids:
                row_doc.append(doc_index.setdefault(d, len(doc_index)))
        counts = np.concatenate([p.counts for p in parts]) if parts else np.zeros(0, np.int64)
        n_tok = int(counts.sum())
        st.tokens_scored, st.candidates = n_tok, len(doc_index)
        if n_tok == 0:
            st.ms = _ms(t0, t1, t2, time.perf_counter(), None, None)
            return [], st
        codes = np.concatenate([p.codes for p in parts])
        tok_centroid = np.repeat(np.array([p.centroid for p in parts], dtype=np.int64),
                                 [p.codes.shape[0] for p in parts])
        tok_doc = np.repeat(np.asarray(row_doc, dtype=np.int64), counts)
        scores = pq_scores(luts, codes, self.use_kernel)
        scores += cscores[:, tok_centroid]
        gids, gscores = maxsim_by_group(scores, tok_doc)
        ids = list(doc_index)                                     # insertion order = index
        t3 = time.perf_counter()

        keep = min(len(gids), max(k, rerank) if rerank else k)
        top = np.argpartition(-gscores, keep - 1)[:keep] if keep < len(gids) else np.arange(len(gids))
        top = top[np.argsort(-gscores[top], kind="stable")]
        if not rerank:
            st.ms = _ms(t0, t1, t2, t3, None, None)
            return [SearchResult(ids[gids[i]], float(gscores[i])) for i in top[:k]], st

        # ---- stage 2: rescore the best candidates from all of their tokens ----
        cand = [ids[gids[i]] for i in top]
        full = self.store.read_doc_tokens(self.cfg, scope, cand)
        t4 = time.perf_counter()
        cand = [d for d in cand if d in full]
        st.reranked = len(cand)
        if not cand:
            st.ms = _ms(t0, t1, t2, t3, t4, time.perf_counter())
            return [], st
        lens = [full[d][0].shape[0] for d in cand]
        all_cids = np.concatenate([full[d][0] for d in cand]).astype(np.int64)
        all_codes = np.concatenate([full[d][1] for d in cand])
        s2 = pq_scores(luts, all_codes, self.use_kernel)
        s2 += cscores[:, all_cids]
        g2, sc2 = maxsim_by_group(s2, np.repeat(np.arange(len(cand)), lens))
        order = np.argsort(-sc2, kind="stable")[:k]
        t5 = time.perf_counter()
        st.ms = _ms(t0, t1, t2, t3, t4, t5)
        return [SearchResult(cand[g2[i]], float(sc2[i])) for i in order], st

    def _need_encoder(self) -> None:
        if self.encoder is None:
            raise RuntimeError("this Index was created without an encoder")


def _ms(t0, t1, t2, t3, t4, t5) -> dict:
    out = {"plan": (t1 - t0) * 1e3, "read_partitions": (t2 - t1) * 1e3, "score": (t3 - t2) * 1e3}
    end = t3
    if t4 is not None:
        out["read_docs"] = (t4 - t3) * 1e3
        out["rerank"] = (t5 - t4) * 1e3
        end = t5
    out["total"] = (end - t0) * 1e3
    return {k: round(v, 3) for k, v in out.items()}
