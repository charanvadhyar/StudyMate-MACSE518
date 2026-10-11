from dataclasses import dataclass, asdict
import json


@dataclass(frozen=True)
class IndexConfig:
    """Shape of one index. Fixed once the quantizer is trained."""

    dim: int = 128        # ColBERT token vector size
    k_ivf: int = 1024     # number of centroids (= posting partitions per scope and bucket)
    m_pq: int = 32        # PQ sub-quantizers (bytes per token code)
    k_pq: int = 256       # codebook entries per sub-quantizer (must fit in one byte)
    n_buckets: int = 1    # each centroid's posting list is split over this many partitions
    postings: str = "codes"   # "codes": posting rows carry the PQ codes (stage 1 scores tokens)
                              # "ids":   posting rows carry only the chunk id; codes are stored once,
                              #          in doc_tokens, and stage 1 scores by centroid alone
                              # "single": posting rows carry the PQ codes and doc_tokens keeps only the
                              #          chunk's centroid ids, so codes are stored once. The rescoring
                              #          step mixes two precisions: codes for vectors in the partitions
                              #          the query read, the centroid alone for the chunk's other vectors

    def __post_init__(self):
        if self.dim % self.m_pq != 0:
            raise ValueError(f"dim={self.dim} must be divisible by m_pq={self.m_pq}")
        if not 1 <= self.k_pq <= 256:
            raise ValueError("k_pq must be between 1 and 256")
        if not 1 <= self.k_ivf <= 65535:
            raise ValueError("k_ivf must be between 1 and 65535")
        if self.n_buckets < 1:
            raise ValueError("n_buckets must be at least 1")
        if self.postings not in ("codes", "ids", "single"):
            raise ValueError("postings must be 'codes', 'ids' or 'single'")

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @staticmethod
    def from_json(s: str) -> "IndexConfig":
        return IndexConfig(**json.loads(s))
