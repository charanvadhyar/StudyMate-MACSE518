"""Storage interface for the index.

Layout (the same for every backend):

  postings    one partition per (scope, centroid, bucket); one row per chunk that
              has tokens in that centroid, holding those tokens' PQ codes.
  doc_tokens  one partition per (scope, chunk): every token of the chunk as
              (centroid id, PQ code). Used for the exact-order rerank and deletes.
  stats       token count per (scope, centroid), kept up to date on write.

A "partition read" (the unit the planner budgets) is one postings partition.
"""
from __future__ import annotations

import zlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np

from ..config import IndexConfig
from ..quantizer import Quantizer


def bucket_of(doc_id: str, n_buckets: int) -> int:
    return zlib.crc32(doc_id.encode("utf-8")) % n_buckets if n_buckets > 1 else 0


@dataclass
class Partition:
    """Contents of the postings partitions of one centroid (all buckets merged)."""

    centroid: int
    doc_ids: list[str]        # one entry per row
    counts: np.ndarray        # [rows] tokens per row
    codes: np.ndarray         # [sum(counts), m_pq] uint8


@dataclass
class IOStats:
    partitions_read: int = 0
    rows_read: int = 0
    bytes_read: int = 0
    doc_token_reads: int = 0
    writes: int = 0

    def reset(self) -> None:
        self.partitions_read = self.rows_read = self.bytes_read = 0
        self.doc_token_reads = self.writes = 0


class Store(ABC):
    """Backend contract. `cfg` is set once a quantizer has been saved or loaded."""

    def __init__(self) -> None:
        self.io = IOStats()

    # ---- quantizer ----
    @abstractmethod
    def save_quantizer(self, index_id: str, quantizer: Quantizer) -> None: ...

    @abstractmethod
    def load_quantizer(self, index_id: str) -> Quantizer | None: ...

    # ---- writes ----
    @abstractmethod
    def write_doc(self, cfg: IndexConfig, scope: str, doc_id: str,
                  cids: np.ndarray, codes: np.ndarray) -> None:
        """Store one chunk. cids uint16 [n], codes uint8 [n, m_pq]. Does not check for an
        existing chunk with the same id; call delete_doc first when replacing."""

    @abstractmethod
    def delete_doc(self, cfg: IndexConfig, scope: str, doc_id: str) -> bool:
        """Remove a chunk everywhere. Returns False when it was not present."""

    # ---- reads ----
    @abstractmethod
    def read_partitions(self, cfg: IndexConfig, scope: str,
                        centroids: list[int]) -> list[Partition]:
        """Read the postings of the given centroids (every bucket of each)."""

    @abstractmethod
    def read_doc_tokens(self, cfg: IndexConfig, scope: str,
                        doc_ids: list[str]) -> dict[str, tuple[np.ndarray, np.ndarray]]:
        """doc_id -> (cids uint16 [n], codes uint8 [n, m_pq]); missing ids are omitted."""

    @abstractmethod
    def partition_sizes(self, cfg: IndexConfig, scope: str) -> np.ndarray:
        """Token count per centroid for this scope, int64 [k_ivf]."""

    def close(self) -> None:  # pragma: no cover - backends override when needed
        pass


def group_by_centroid(cids: np.ndarray, codes: np.ndarray) -> dict[int, np.ndarray]:
    """Split one chunk's tokens into {centroid: codes [n_c, m_pq]}, token order preserved."""
    order = np.argsort(cids, kind="stable")
    sc = cids[order]
    starts = np.flatnonzero(np.r_[True, sc[1:] != sc[:-1]])
    ends = np.r_[starts[1:], len(sc)]
    return {int(sc[s]): np.ascontiguousarray(codes[order[s:e]]) for s, e in zip(starts, ends)}
