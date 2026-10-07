import numpy as np
from fastapi.testclient import TestClient

from smdb import Index, IndexConfig, Quantizer
from smdb import service
from smdb.encoder import HashEncoder
from smdb.store import MemoryStore


def test_index_search_delete_over_http():
    enc = HashEncoder(dim=32)
    texts = {
        "db:0": "a b tree keeps keys sorted and supports range queries on disk pages",
        "db:1": "cassandra partitions rows by a partition key and sorts by clustering key",
        "net:0": "tcp uses a three way handshake and retransmits lost segments",
        "algo:0": "quicksort partitions an array around a pivot and recurses on both halves",
    }
    words = sorted({w for t in texts.values() for w in t.split()})
    train = np.stack([enc._vec(w) for w in words] * 8)
    train = train + 0.01 * np.random.default_rng(0).standard_normal(train.shape).astype(np.float32)
    cfg = IndexConfig(dim=32, k_ivf=8, m_pq=8)
    service._state["index"] = Index(MemoryStore(), Quantizer.train(train, cfg, n_init=1), enc)

    with TestClient(service.app) as c:
        assert c.get("/health").json()["status"] == "ok"
        r = c.post("/index", json={"scope": "u1", "chunks": [{"doc_id": k, "text": v}
                                                             for k, v in texts.items()]})
        assert r.json()["indexed"] == 4 and r.json()["tokens"] > 20

        r = c.post("/search", json={"scope": "u1", "query": "three way handshake tcp", "k": 2})
        body = r.json()
        assert body["results"][0]["doc_id"] == "net:0"
        assert body["stats"]["partitions_read"] >= 1

        r = c.post("/search", json={"scope": "u1", "query": "partition key clustering",
                                    "planner": "fixed", "nprobe": 2})
        assert r.json()["results"][0]["doc_id"] == "db:1"

        assert c.post("/search", json={"scope": "other", "query": "tcp"}).json()["results"] == []
        assert c.post("/search", json={"scope": "u1", "query": "x", "planner": "bad"}).status_code == 422
        assert c.post("/delete", json={"scope": "u1", "doc_ids": ["net:0", "zz"]}).json() == {"deleted": 1}
        r = c.post("/search", json={"scope": "u1", "query": "three way handshake tcp"})
        assert all(x["doc_id"] != "net:0" for x in r.json()["results"])
