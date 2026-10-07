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

    def __post_init__(self):
        if self.dim % self.m_pq != 0:
            raise ValueError(f"dim={self.dim} must be divisible by m_pq={self.m_pq}")
        if not 1 <= self.k_pq <= 256:
            raise ValueError("k_pq must be between 1 and 256")
        if not 1 <= self.k_ivf <= 65535:
            raise ValueError("k_ivf must be between 1 and 65535")
        if self.n_buckets < 1:
            raise ValueError("n_buckets must be at least 1")

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @staticmethod
    def from_json(s: str) -> "IndexConfig":
        return IndexConfig(**json.loads(s))
