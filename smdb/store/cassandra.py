"""Cassandra backend. See schema.cql for the table layout."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..config import IndexConfig
from ..quantizer import Quantizer
from .base import Partition, Store, bucket_of, group_by_centroid
from .memory import _to_partition


class CassandraStore(Store):
    def __init__(self, contact_points: list[str] | None = None, port: int = 9042,
                 keyspace: str = "smdb", local_dc: str = "datacenter1",
                 username: str | None = None, password: str | None = None,
                 replication_factor: int = 1, concurrency: int = 64,
                 init_schema: bool = True) -> None:
        super().__init__()
        from cassandra.auth import PlainTextAuthProvider
        from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
        from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy

        if not keyspace.replace("_", "").isalnum():
            raise ValueError("keyspace must be alphanumeric/underscore")
        self.keyspace = keyspace
        self.concurrency = concurrency
        auth = PlainTextAuthProvider(username, password) if username and password else None
        profile = ExecutionProfile(
            load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc=local_dc)),
            request_timeout=30.0,
        )
        self._cluster = Cluster(contact_points or ["127.0.0.1"], port=port, auth_provider=auth,
                                protocol_version=4,   # v5 framing: "CRC mismatch" errors in the driver
                                execution_profiles={EXEC_PROFILE_DEFAULT: profile})
        self._session = self._cluster.connect()
        if init_schema:
            self.init_schema(replication_factor)
        self._prepare()

    # ------------------------------------------------------------------ setup
    def init_schema(self, replication_factor: int = 1) -> None:
        self._session.execute(
            f"CREATE KEYSPACE IF NOT EXISTS {self.keyspace} WITH replication = "
            f"{{'class': 'SimpleStrategy', 'replication_factor': {int(replication_factor)}}}"
        )
        ddl = (Path(__file__).parent / "schema.cql").read_text(encoding="utf-8")
        ddl = "\n".join(line.split("--", 1)[0] for line in ddl.splitlines())   # drop comments
        for stmt in ddl.split(";"):
            stmt = stmt.strip()
            if stmt:
                self._session.execute(stmt.replace("{keyspace}", self.keyspace))

    def _prepare(self) -> None:
        ks, p = self.keyspace, self._session.prepare
        self._q_meta_put = p(f"INSERT INTO {ks}.index_meta (index_id, config, centroids, codebooks) VALUES (?, ?, ?, ?)")
        self._q_meta_get = p(f"SELECT config, centroids, codebooks FROM {ks}.index_meta WHERE index_id = ?")
        self._q_post_put = p(f"INSERT INTO {ks}.postings (scope_id, centroid_id, bucket, doc_id, codes) VALUES (?, ?, ?, ?, ?)")
        self._q_post_del = p(f"DELETE FROM {ks}.postings WHERE scope_id = ? AND centroid_id = ? AND bucket = ? AND doc_id = ?")
        self._q_post_get = p(f"SELECT doc_id, codes FROM {ks}.postings WHERE scope_id = ? AND centroid_id = ? AND bucket = ?")
        self._q_post_row = p(f"SELECT codes FROM {ks}.postings WHERE scope_id = ? AND centroid_id = ? AND bucket = ? AND doc_id = ?")
        self._q_doc_put = p(f"INSERT INTO {ks}.doc_tokens (scope_id, doc_id, centroid_ids, codes) VALUES (?, ?, ?, ?)")
        self._q_doc_get = p(f"SELECT centroid_ids, codes FROM {ks}.doc_tokens WHERE scope_id = ? AND doc_id = ?")
        self._q_doc_del = p(f"DELETE FROM {ks}.doc_tokens WHERE scope_id = ? AND doc_id = ?")
        self._q_stat_add = p(f"UPDATE {ks}.partition_stats SET n_tokens = n_tokens + ? WHERE scope_id = ? AND centroid_id = ?")
        self._q_stat_get = p(f"SELECT centroid_id, n_tokens FROM {ks}.partition_stats WHERE scope_id = ?")
        self._q_post_get.fetch_size = 5000

    def _many(self, statement, params: list[tuple]) -> list:
        """Run one prepared statement for many parameter sets, results in input order."""
        from cassandra.concurrent import execute_concurrent_with_args

        if not params:
            return []
        results = execute_concurrent_with_args(self._session, statement, params,
                                               concurrency=self.concurrency,
                                               raise_on_first_error=True)
        return [r.result_or_exc for r in results]

    # -------------------------------------------------------------- quantizer
    def save_quantizer(self, index_id: str, quantizer: Quantizer) -> None:
        cent, books = quantizer.to_bytes()
        self._session.execute(self._q_meta_put, (index_id, quantizer.cfg.to_json(), cent, books))

    def load_quantizer(self, index_id: str) -> Quantizer | None:
        row = self._session.execute(self._q_meta_get, (index_id,)).one()
        if row is None:
            return None
        return Quantizer.from_bytes(IndexConfig.from_json(row.config), row.centroids, row.codebooks)

    # ----------------------------------------------------------------- writes
    def write_doc(self, cfg, scope, doc_id, cids, codes) -> None:
        self.write_docs(cfg, scope, [(doc_id, cids, codes)])

    def write_docs(self, cfg, scope, items) -> None:
        """Bulk path: every posting row of the batch goes out in one concurrent wave, and the
        partition counters get ONE update per centroid for the whole batch. Counter updates
        are read-before-write in Cassandra, so per-chunk increments dominate ingest time."""
        posts, docs = [], []
        added: dict[int, int] = {}
        for doc_id, cids, codes in items:
            b = bucket_of(doc_id, cfg.n_buckets)
            for c, g in group_by_centroid(cids, codes).items():
                posts.append((scope, c, b, doc_id, g.tobytes() if cfg.postings != "ids" else b""))
                added[c] = added.get(c, 0) + g.shape[0]
            docs.append((scope, doc_id,
                         np.ascontiguousarray(cids, dtype="<u2").tobytes(),
                         b"" if cfg.postings == "single"
                         else np.ascontiguousarray(codes, dtype=np.uint8).tobytes()))
        self._many(self._q_post_put, posts)
        self._many(self._q_doc_put, docs)
        # Counters last: they are not idempotent, so a retried ingest of the same
        # chunk must go through delete_doc first (Index.add does this).
        self._many(self._q_stat_add, [(n, scope, c) for c, n in added.items()])
        self.io.writes += len(posts) + len(docs) + len(added)

    def delete_doc(self, cfg, scope, doc_id) -> bool:
        row = self._session.execute(self._q_doc_get, (scope, doc_id)).one()
        if row is None:
            return False
        cids = np.frombuffer(row.centroid_ids, dtype="<u2")
        b = bucket_of(doc_id, cfg.n_buckets)
        uniq, counts = np.unique(cids, return_counts=True)
        self._many(self._q_post_del, [(scope, int(c), b, doc_id) for c in uniq])
        self._many(self._q_stat_add, [(-int(n), scope, int(c)) for c, n in zip(uniq, counts)])
        self._session.execute(self._q_doc_del, (scope, doc_id))
        return True

    # ------------------------------------------------------------------ reads
    def read_partitions(self, cfg, scope, centroids) -> list[Partition]:
        keys = [(scope, int(c), b) for c in centroids for b in range(cfg.n_buckets)]
        results = self._many(self._q_post_get, keys)
        self.io.partitions_read += len(keys)
        out = []
        for i, c in enumerate(centroids):
            doc_ids: list[str] = []
            blobs: list[bytes] = []
            for rs in results[i * cfg.n_buckets:(i + 1) * cfg.n_buckets]:
                for row in rs:  # iterating pages through large partitions
                    doc_ids.append(row.doc_id)
                    blobs.append(row.codes)
            self.io.rows_read += len(doc_ids)
            self.io.bytes_read += sum(len(x) for x in blobs)
            out.append(_to_partition(int(c), doc_ids, blobs, cfg.m_pq))
        return out

    def read_posting_rows(self, cfg, scope, keys):
        results = self._many(self._q_post_row,
                             [(scope, int(c), bucket_of(d, cfg.n_buckets), d) for c, d in keys])
        self.io.row_reads += len(keys)
        out = []
        for rs in results:
            row = rs.one()
            blob = row.codes if row is not None and row.codes else b""
            out.append(np.frombuffer(blob, dtype=np.uint8).reshape(-1, cfg.m_pq))
        return out

    def read_doc_tokens(self, cfg, scope, doc_ids):
        results = self._many(self._q_doc_get, [(scope, d) for d in doc_ids])
        self.io.doc_token_reads += len(doc_ids)
        out = {}
        for d, rs in zip(doc_ids, results):
            row = rs.one()
            if row is not None:
                out[d] = (np.frombuffer(row.centroid_ids, dtype="<u2"),
                          np.frombuffer(row.codes, dtype=np.uint8).reshape(-1, cfg.m_pq))
        return out

    def partition_sizes(self, cfg, scope) -> np.ndarray:
        sizes = np.zeros(cfg.k_ivf, dtype=np.int64)
        for row in self._session.execute(self._q_stat_get, (scope,)):
            if 0 <= row.centroid_id < cfg.k_ivf:
                sizes[row.centroid_id] = max(0, row.n_tokens)
        return sizes

    def close(self) -> None:
        self._cluster.shutdown()
