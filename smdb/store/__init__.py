from .base import IOStats, Partition, Store
from .memory import MemoryStore

__all__ = ["Store", "Partition", "IOStats", "MemoryStore", "CassandraStore"]


def __getattr__(name):
    # Imported lazily so the memory backend works without cassandra-driver.
    if name == "CassandraStore":
        from .cassandra import CassandraStore
        return CassandraStore
    raise AttributeError(name)
