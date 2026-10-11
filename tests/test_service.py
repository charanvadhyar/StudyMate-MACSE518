import pytest
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
        # bulk path for first-time loads gives the same searchable result
        r = c.post("/index", json={"scope": "u2", "replace": False,
                                   "chunks": [{"doc_id": k, "text": v} for k, v in texts.items()]})
        assert r.json()["indexed"] == 4 and r.json()["tokens"] > 20
        r = c.post("/search", json={"scope": "u2", "query": "three way handshake tcp", "k": 2})
        assert r.json()["results"][0]["doc_id"] == "net:0"
        assert c.post("/search", json={"scope": "u1", "query": "x", "planner": "bad"}).status_code == 422
        assert c.post("/delete", json={"scope": "u1", "doc_ids": ["net:0", "zz"]}).json() == {"deleted": 1}
        r = c.post("/search", json={"scope": "u1", "query": "three way handshake tcp"})
        assert all(x["doc_id"] != "net:0" for x in r.json()["results"])


def test_live_comparison_runs_three_systems(monkeypatch):
    import time
    monkeypatch.setenv("SMDB_COMPARE_STORE", "memory")
    enc = HashEncoder(dim=32)
    rng = np.random.default_rng(1)
    train = rng.standard_normal((2000, 32)).astype(np.float32)
    train /= np.linalg.norm(train, axis=1, keepdims=True)
    cfg = IndexConfig(dim=32, k_ivf=8, m_pq=8)
    service._state["index"] = Index(MemoryStore(), Quantizer.train(train, cfg, n_init=1), enc, pool="centroid")
    chunks = [f"chunk number {i} talks about topic {i % 7} and locking and recovery of transactions" for i in range(40)]
    with TestClient(service.app) as c:
        assert c.post("/compare", json={"chunks": []}).status_code == 422
        job = c.post("/compare", json={"chunks": chunks, "max_chunks": 25}).json()
        assert job["total"] == 25 and job["truncated_from"] == 40
        for _ in range(200):
            body = c.get(f"/compare/{job['job_id']}").json()
            if body["state"] != "running":
                break
            time.sleep(0.05)
        assert body["state"] == "done", body
        single, live, ours = body["systems"]
        assert [s["id"] for s in body["systems"]] == ["single", "live", "smdb"]
        assert all(s["state"] == "done" and s["done"] == 25 and s["chunks_per_s"] for s in body["systems"])
        assert single["vectors"] == 25 and live["vectors"] > 25
        assert ours["bytes"] < live["bytes"]                    # compressed codes vs float vectors
        assert c.get("/compare/nope").status_code == 404

        # quality: the three indexes stay searchable until the job is closed
        jid = job["job_id"]
        assert body["searchable"] is True
        r = c.post(f"/compare/{jid}/search", json={"query": "chunk number 7 talks about topic 0", "k": 3}).json()
        assert [s["id"] for s in r["systems"]] == ["single", "live", "smdb"]
        assert all(len(s["results"]) == 3 and s["ms"] >= 0 for s in r["systems"])
        assert all("preview" in s["results"][0] for s in r["systems"])
        picked = c.get(f"/compare/{jid}/sample", params={"n": 6}).json()["items"]
        assert 1 <= len(picked) <= 6 and all(0 <= p["chunk"] < 25 for p in picked)
        items = [{"chunk": p["chunk"], "question": p["text"]} for p in picked]   # the chunk itself as the question
        t = c.post(f"/compare/{jid}/selftest", json={"items": items}).json()
        assert t["questions"] == len(items)
        for sysrow in t["systems"]:
            assert 0 <= sysrow["top1"] <= sysrow["top5"] <= 1
        assert next(x for x in t["systems"] if x["id"] == "smdb")["top5"] >= 0.5
        assert c.delete(f"/compare/{jid}").json() == {"closed": True}
        assert c.post(f"/compare/{jid}/search", json={"query": "x"}).status_code == 409
        assert c.post("/compare/nope/search", json={"query": "x"}).status_code == 404

        # a running comparison can be cancelled, and starting a new one replaces the old
        j1 = c.post("/compare", json={"chunks": chunks * 20, "max_chunks": 800}).json()
        assert c.delete(f"/compare/{j1['job_id']}").json() == {"closed": True}
        for _ in range(200):
            b1 = c.get(f"/compare/{j1['job_id']}").json()
            if b1["state"] != "running":
                break
            time.sleep(0.05)
        assert b1["state"] == "failed" and b1["error"] == "cancelled" and b1["searchable"] is False


def test_extract_pdf_returns_sectioned_chunks():
    pymupdf = pytest.importorskip("pymupdf")
    from tests.test_pdf import _make
    import tempfile, os
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "b.pdf")
        _make(path, True)
        data = open(path, "rb").read()
    enc = HashEncoder(dim=32)
    train = np.random.default_rng(2).standard_normal((500, 32)).astype(np.float32)
    service._state["index"] = Index(MemoryStore(), Quantizer.train(train, IndexConfig(dim=32, k_ivf=4, m_pq=8), n_init=1), enc)
    with TestClient(service.app) as c:
        assert c.post("/extract", content=b"not a pdf").status_code == 422
        r = c.post("/extract", content=data, headers={"Content-Type": "application/pdf"})
        assert r.status_code == 200
        body = r.json()
        assert body["with_sections"] and body["skipped_reference_chunks"] >= 1
        lock = [x for x in body["chunks"] if x["section"].endswith("1.2 Locking")]
        assert lock and lock[0]["indexed_text"].startswith("Chapter 1: Transactions > 1.2 Locking. ")
        assert all(x["page_start"] >= 1 and x["kind"] in ("body", "exercise") for x in body["chunks"])
