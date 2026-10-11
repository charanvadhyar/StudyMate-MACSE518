# StudyMateDb (smdb)

Late-interaction (ColBERT) retrieval whose index lives in Cassandra partitions.
Built standalone first; StudyMate will call it through the HTTP sidecar.

**Private until the patent application is filed. Do not publish code, results or write-ups.**

## Repository layout

| Folder | What it is | Deployed to |
|---|---|---|
| `smdb/`, `kernel/`, `scripts/`, `deploy/sidecar/` | Retrieval index and its HTTP sidecar (Python, Rust kernel) | Railway service `retrieval` |
| `backend/` | StudyMate API (Node, Express) and the Cassandra cluster files in `backend/deploy/cassandra/` | Railway services `api`, `cassandra-1..3` |
| `frontend/` | StudyMate web app (React) | Vercel |

Secrets stay in each folder's `.env` (ignored). `books/` (copyrighted textbooks) and database dumps are never committed.

## What it does

- **Index**: every token vector is stored as a centroid id plus a product-quantized
  residual (IVF + PQ, ported from colvec). One Cassandra partition holds one
  centroid's posting list for one scope (`scope` = a user, or a benchmark dataset).
- **Query**: score the query tokens against the centroids in memory, let a *probe
  planner* choose which partitions to read, score what was read with the Rust AVX2
  kernel, then rescore the best candidates from their full token codes.
- **Planners** (`smdb/planner.py`):
  - `fixed`: each query token reads its own top-`nprobe` centroids (PLAID-style baseline).
  - `mass`: one shared budget of partition reads for the whole query. Under evaluation.

Tables are in `smdb/store/schema.cql`: `postings`, `doc_tokens`, `partition_stats`, `index_meta`.

## Setup (Windows, Python 3.11)

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[encoder,bench,dev]"

# Rust kernel (optional; a NumPy fallback is used when it is missing)
pip install maturin
cd kernel
maturin develop --release
cd ..

pytest                      # in-memory store, synthetic vectors
```

Cassandra 5.0 (needed for the SAI vector baseline; the index itself also runs on 4.1):

```powershell
docker compose up -d        # wait about a minute
python -m smdb.cli init
$env:SMDB_TEST_CASSANDRA = "127.0.0.1"
pytest                      # same tests, now also against Cassandra
```

## Benchmark

```powershell
python scripts/bench.py --synthetic                      # smoke test, no model needed
python scripts/bench.py --dataset beir/scifact/test      # encodes once, caches in data/
python scripts/bench.py --dataset beir/scifact/test --store cassandra
```

The table compares `fixed`, `mass` and the `oracle` (the partitions a perfect planner
would read) on partitions read, nDCG@10 and overlap with exact MaxSim. Results are
written to `results/`.

## Sidecar

```powershell
python -m smdb.cli train --vectors data\sample_tokens.npy     # once per index
uvicorn smdb.service:app --port 8100
```

- `POST /index`  `{ "scope": "...", "chunks": [{ "doc_id": "...", "text": "..." }] }`
- `POST /search` `{ "scope": "...", "query": "...", "k": 10, "planner": "mass", "budget": 16 }`
- `POST /delete` `{ "scope": "...", "doc_ids": ["..."] }`
- `GET  /health`

Settings are environment variables, listed at the top of `smdb/service.py`.

## Status

| Part | State |
|---|---|
| Quantizer, planners, scorer, in-memory store, sidecar | Tested on synthetic vectors (`pytest`) |
| Rust kernel | Builds; output matches the NumPy fallback |
| Cassandra store | Written, **not yet run against a live cluster** |
| ColBERT encoder | Ported from colvec, **not yet run** (needs the model download) |
| Planner quality on real data | **Not measured yet**: run `scripts/bench.py` on SciFact |
