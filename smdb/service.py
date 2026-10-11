"""HTTP sidecar. Run with:  uvicorn smdb.service:app --port 8100

Environment
  SMDB_STORE          cassandra (default) | memory
  SMDB_CONTACT_POINTS comma-separated hosts            (default 127.0.0.1)
  SMDB_PORT           CQL port                         (default 9042)
  SMDB_KEYSPACE       keyspace for the index tables    (default smdb)
  SMDB_LOCAL_DC       datacenter name                  (default datacenter1)
  SMDB_USER / SMDB_PASSWORD   optional auth
  SMDB_RF             replication factor when the keyspace is first created (default 1; 3 on a 3-node cluster)
  SMDB_INDEX_ID       which trained quantizer to use   (default default)
  SMDB_ENCODER        colbert (default) | hash  (hash = wiring tests only)
  SMDB_MODEL / SMDB_DEVICE / SMDB_MARKERS   encoder settings
  SMDB_POOL           none | centroid (default) | hierarchical   how chunks are pooled when indexed.
                      centroid stores about half the vectors; none is slightly more accurate.

  SMDB_COMPARE_PORT   CQL port of a Cassandra 5.0 used by the live comparison (default 9044)
  SMDB_COMPARE_HOSTS / SMDB_SINGLE_MODEL / SMDB_COMPARE_STORE   see smdb/compare.py

For StudyMate (see scripts/run_sidecar.ps1):
  SMDB_MODEL=answerdotai/answerai-colbert-small-v1  SMDB_MARKERS=colbert
"""
from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
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
            replication_factor=int(os.getenv("SMDB_RF", "1")),
        )
    if os.getenv("SMDB_ENCODER", "colbert").lower() == "hash":
        from .encoder import HashEncoder
        encoder = HashEncoder()
    else:
        from .encoder import DEFAULT_MODEL, ColbertEncoder
        encoder = ColbertEncoder(os.getenv("SMDB_MODEL", DEFAULT_MODEL),
                                 device=os.getenv("SMDB_DEVICE", "cpu"),
                                 markers=os.getenv("SMDB_MARKERS", "legacy"))
    return Index.open(store, os.getenv("SMDB_INDEX_ID", "default"), encoder,
                      pool=os.getenv("SMDB_POOL", "centroid").lower())


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
    # False = these ids are new in this scope: skip the per-chunk "does it exist" check and write
    # the whole batch in one go. Only for first-time loads; re-indexing must keep the default.
    replace: bool = True


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


class CompareSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    k: int = Field(default=3, ge=1, le=10)


class SelfTestItem(BaseModel):
    chunk: int
    question: str


class SelfTestRequest(BaseModel):
    items: list[SelfTestItem]


class CompareRequest(BaseModel):
    chunks: list[str]
    max_chunks: int = Field(default=300, ge=1, le=5000)


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
            "encoder": type(idx.encoder).__name__, "pool": idx.pool}


@app.post("/index")
def index_chunks(req: IndexRequest):
    idx = _index()
    with _lock:
        vectors = idx.encoder.encode_docs([c.text for c in req.chunks])
        if req.replace:
            tokens = sum(idx.add(req.scope, c.doc_id, v) for c, v in zip(req.chunks, vectors))
        else:
            items = [(c.doc_id, *idx.quantize(v)) for c, v in zip(req.chunks, vectors) if len(v)]
            idx.store.write_docs(idx.cfg, req.scope, items)
            idx._sizes.pop(req.scope, None)
            tokens = sum(len(cids) for _, cids, _ in items)
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


@app.post("/compare")
def compare_start(req: CompareRequest):
    """Index the given chunks three ways (single vector + SAI, ColBERT Live! design, this index)
    and time each. Returns a job id; poll GET /compare/{job_id} for live progress."""
    from . import compare
    idx = _index()
    try:
        job = compare.start(idx, req.chunks, _lock, req.max_chunks)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:      # usually: the Cassandra 5.0 used for the comparison is not running
        raise HTTPException(503, f"comparison store unavailable: {type(e).__name__}: {e}")
    return job.view()


@app.get("/compare/{job_id}")
def compare_status(job_id: str):
    from . import compare
    job = compare.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown comparison job")
    return job.view()


def _compare_call(fn, *args):
    try:
        return fn(*args)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'"))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@app.post("/compare/{job_id}/search")
def compare_search(job_id: str, req: CompareSearchRequest):
    """One question through the three indexes of a finished comparison."""
    from . import compare
    return _compare_call(compare.search, job_id, req.query, req.k)


@app.get("/compare/{job_id}/sample")
def compare_sample(job_id: str, n: int = 20):
    """Random chunks of the comparison, for writing self-test questions."""
    from . import compare
    return {"items": _compare_call(compare.sample, job_id, max(1, min(n, 100)))}


@app.post("/compare/{job_id}/selftest")
def compare_selftest(job_id: str, req: SelfTestRequest):
    """Known-item accuracy of the three indexes on questions written for specific chunks."""
    from . import compare
    return _compare_call(compare.selftest, job_id, [i.model_dump() for i in req.items])


@app.delete("/compare/{job_id}")
def compare_close(job_id: str):
    from . import compare
    return {"closed": compare.close(job_id)}


@app.post("/extract")
async def extract_pdf(request: Request, target_words: int = 160):
    """PDF bytes in the request body -> section-aware chunks (see smdb/pdf.py).

    Each chunk carries its section path and page range, and `indexed_text`: the text prefixed
    with its section path, which is what should be sent to /index so a chunk keeps its context.
    Reference material (bibliography, index, preface) is left out."""
    import tempfile
    from pathlib import Path

    data = await request.body()
    if not data.startswith(b"%PDF"):
        raise HTTPException(422, "the request body is not a PDF file")
    try:
        from .pdf import extract
    except ImportError:
        raise HTTPException(501, "PDF support is not installed on the sidecar (pip install pymupdf)")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "upload.pdf"
        path.write_bytes(data)
        try:
            chunks = extract(path, book="doc", target_words=target_words)
        except ValueError as e:              # no text layer: a scanned PDF
            raise HTTPException(422, str(e))
        except Exception as e:
            raise HTTPException(422, f"could not read this PDF: {type(e).__name__}: {e}")
    keep = [c for c in chunks if c.kind != "reference"]
    return {
        "chunks": [{"text": c.text, "indexed_text": c.indexed_text(), "kind": c.kind,
                    "section": " > ".join(c.section_path[-2:]), "chapter": c.chapter,
                    "page_start": c.page_start, "page_end": c.page_end} for c in keep],
        "pages": max((c.page_end for c in chunks), default=0),
        "skipped_reference_chunks": len(chunks) - len(keep),
        "with_sections": any(c.section_path for c in keep),
    }
