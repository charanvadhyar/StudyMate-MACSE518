"""In-memory backend with the same partition layout as Cassandra.

For tests and for planner experiments: it counts partition reads exactly as the
Cassandra backend does, without needing a cluster.
"""
from __future__ import annotations

import numpy as np

from ..config import IndexConfig
from ..quantizer import Quantizer
from .base import Partition, Store, bucket_of, group_by_centroid


class MemoryStore(Store):
    def __init__(self) -> None:
        super().__init__()
        self._quantizers: dict[str, Quantizer] = {}
        self._postings: dict[tuple[str, int, int], dict[str, bytes]] = {}
        self._doc_tokens: dict[tuple[str, str], tuple[bytes, bytes]] = {}
        self._sizes: dict[str, np.ndarray] = {}

    def save_quantizer(self, index_id: str, quantizer: Quantizer) -> None:
        self._quantizers[index_id] = quantizer

    def load_quantizer(self, index_id: str) -> Quantizer | None:
        return self._quantizers.get(index_id)

    def write_doc(self, cfg, scope, doc_id, cids, codes) -> None:
        b = bucket_of(doc_id, cfg.n_buckets)
        sizes = self._sizes.setdefault(scope, np.zeros(cfg.k_ivf, dtype=np.int64))
        for c, part_codes in group_by_centroid(cids, codes).items():
            blob = part_codes.tobytes() if cfg.postings != "ids" else b""
            self._postings.setdefault((scope, c, b), {})[doc_id] = blob
            sizes[c] += part_codes.shape[0]
            self.io.writes += 1
        self._doc_tokens[(scope, doc_id)] = (
            np.ascontiguousarray(cids, dtype=np.uint16).tobytes(),
            b"" if cfg.postings == "single" else np.ascontiguousarray(codes, dtype=np.uint8).tobytes(),
        )
        self.io.writes += 1

    def delete_doc(self, cfg, scope, doc_id) -> bool:
        entry = self._doc_tokens.pop((scope, doc_id), None)
        if entry is None:
            return False
        cids = np.frombuffer(entry[0], dtype=np.uint16)
        b = bucket_of(doc_id, cfg.n_buckets)
        sizes = self._sizes[scope]
        for c, n in zip(*np.unique(cids, return_counts=True)):
            self._postings.get((scope, int(c), b), {}).pop(doc_id, None)
            sizes[int(c)] -= int(n)
        return True

    def read_partitions(self, cfg, scope, centroids) -> list[Partition]:
        out = []
        for c in centroids:
            doc_ids: list[str] = []
            blobs: list[bytes] = []
            for b in range(cfg.n_buckets):
                self.io.partitions_read += 1
                rows = self._postings.get((scope, int(c), b))
                if rows:
                    doc_ids.extend(rows.keys())
                    blobs.extend(rows.values())
            out.append(_to_partition(int(c), doc_ids, blobs, cfg.m_pq))
            self.io.rows_read += len(doc_ids)
            self.io.bytes_read += sum(len(x) for x in blobs)
        return out

    def read_posting_rows(self, cfg, scope, keys):
        out = []
        for c, d in keys:
            self.io.row_reads += 1
            blob = self._postings.get((scope, int(c), bucket_of(d, cfg.n_buckets)), {}).get(d, b"")
            out.append(np.frombuffer(blob, dtype=np.uint8).reshape(-1, cfg.m_pq))
        return out

    def read_doc_tokens(self, cfg, scope, doc_ids):
        out = {}
        for d in doc_ids:
            self.io.doc_token_reads += 1
            entry = self._doc_tokens.get((scope, d))
            if entry is not None:
                out[d] = (np.frombuffer(entry[0], dtype=np.uint16),
                          np.frombuffer(entry[1], dtype=np.uint8).reshape(-1, cfg.m_pq))
        return out

    def partition_sizes(self, cfg, scope) -> np.ndarray:
        s = self._sizes.get(scope)
        return s.copy() if s is not None else np.zeros(cfg.k_ivf, dtype=np.int64)


def _to_partition(centroid: int, doc_ids: list[str], blobs: list[bytes], m_pq: int) -> Partition:
    counts = np.fromiter((len(x) // m_pq for x in blobs), dtype=np.int64, count=len(blobs))
    if blobs:
        codes = np.frombuffer(b"".join(blobs), dtype=np.uint8).reshape(-1, m_pq)
    else:
        codes = np.zeros((0, m_pq), dtype=np.uint8)
    return Partition(centroid, doc_ids, counts, codes)
