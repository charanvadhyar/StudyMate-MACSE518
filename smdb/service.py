"""HTTP sidecar. Run with:  uvicorn smdb.service:app --port 8100

Environment
  SMDB_STORE          cassandra (default) | memory
  SMDB_CONTACT_POINTS comma-separated hosts            (default 127.0.0.1)
  SMDB_PORT           CQL port                         (default 9042)
  SMDB_KEYSPACE       keyspace for the index tables    (default smdb)
  SMDB_LOCAL_DC       datacenter name                  (default datacenter1)
  SMDB_USER / SMDB_PASSWORD   optional auth
  SMDB_INDEX_ID       which trained quantizer to use   (default default)
  SMDB_ENCODER        colbert (default) | hash  (hash = wiring tests only)
  SMDB_MODEL / SMDB_DEVICE / SMDB_MARKERS   encoder settings
"""
from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .index import Index

_state: dict = {}
_lock = threading.Lock()   # one request at a time through the model and the scorer


def build_index() -> Index:
    kind = os.getenv("SMDB_STORE", "cassandra").lower()
    if kind == "memory":
        from .store import MemoryStore
        store = MemoryStore()
    else:
        from .store import CassandraStore
        store = CassandraStore(
            contact_points=os.getenv("SMDB_CONTACT_POINTS", "127.0.0.1").split(","),
            port=int(os.getenv("SMDB_PORT", "9042")),
            keyspace=os.getenv("SMDB_KEYSPACE", "smdb"),
            local_dc=os.getenv("SMDB_LOCAL_DC", "datacenter1"),
            username=os.getenv("SMDB_USER") or None,
            password=os.getenv("SMDB_PASSWORD") or None,
        )
    if os.getenv("SMDB_ENCODER", "colbert").lower() == "hash":
        from .encoder import HashEncoder
        encoder = HashEncoder()
    else:
        from .encoder import DEFAULT_MODEL, ColbertEncoder
        encoder = ColbertEncoder(os.getenv("SMDB_MODEL", DEFAULT_MODEL),
                                 device=os.getenv("SMDB_DEVICE", "cpu"),
                                 markers=os.getenv("SMDB_MARKERS", "legacy"))
    return Index.open(store, os.getenv("SMDB_INDEX_ID", "default"), encoder)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if "index" not in _state:
        _state["index"] = build_index()
    yield
    idx = _state.pop("index", None)
    if idx is not None:
        idx.store.close()


app = FastAPI(title="smdb retrieval sidecar", lifespan=lifespan)


class Chunk(BaseModel):
    doc_id: str = Field(min_length=1)
    text: str


class IndexRequest(BaseModel):
    scope: str = Field(min_length=1)
    chunks: list[Chunk]


class DeleteRequest(BaseModel):
    scope: str = Field(min_length=1)
    doc_ids: list[str]


class SearchRequest(BaseModel):
    scope: str = Field(min_length=1)
    query: str = Field(min_length=1)
    k: int = Field(default=10, ge=1, le=1000)
    planner: str = "mass"
    rerank: int = Field(default=100, ge=0, le=5000)
    nprobe: int = Field(default=4, ge=1)          # planner=fixed
    budget: int = Field(default=16, ge=1)         # planner=mass
    tau: float = Field(default=0.05, gt=0)
    alpha: float = Field(default=0.0, ge=0)


def _index() -> Index:
    idx = _state.get("index")
    if idx is None:
        raise HTTPException(503, "index not loaded")
    return idx


@app.get("/health")
def health():
    idx = _index()
    from .scorer import HAVE_KERNEL
    return {"status": "ok", "config": idx.cfg.__dict__, "rust_kernel": HAVE_KERNEL,
            "encoder": type(idx.encoder).__name__}


@app.post("/index")
def index_chunks(req: IndexRequest):
    idx = _index()
    with _lock:
        vectors = idx.encoder.encode_docs([c.text for c in req.chunks])
        tokens = sum(idx.add(req.scope, c.doc_id, v) for c, v in zip(req.chunks, vectors))
    return {"indexed": len(req.chunks), "tokens": tokens}


@app.post("/delete")
def delete_chunks(req: DeleteRequest):
    idx = _index()
    with _lock:
        deleted = sum(1 for d in req.doc_ids if idx.delete(req.scope, d))
    return {"deleted": deleted}


@app.post("/search")
def search(req: SearchRequest):
    idx = _index()
    if req.planner not in ("fixed", "mass"):
        raise HTTPException(422, "planner must be 'fixed' or 'mass'")
    with _lock:
        results, st = idx.search_text(req.scope, req.query, req.k, planner=req.planner,
                                      rerank=req.rerank, nprobe=req.nprobe, budget=req.budget,
                                      tau=req.tau, alpha=req.alpha)
    return {"results": [{"doc_id": r.doc_id, "score": r.score} for r in results],
            "stats": st.__dict__}
