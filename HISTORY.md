# Change history

A running log of what changed and why, in the order it happened. Each entry is one logical
change (what would have been its own commit). Entries are added as the work proceeds and
committed together.

Measurements quoted here are from SciFact (BEIR, 5,183 chunks, 300 test queries) with
colbert-ir/colbertv2.0 unless stated otherwise; the raw output is in `results/` and the
`bench_log_*.txt` files.

---

## 2026-10-07

### 1. Standalone late-interaction index on Cassandra  *(committed: f12bd79)*
Quantizer (IVF centroids + residual PQ), memory and Cassandra stores, planners, two-stage
search, FastAPI sidecar, Rust scoring kernel, tests.

### 2. cassandra-driver on Python 3.12+
- `pyproject.toml`: add `pyasyncore` for Python >= 3.12 (the driver's default event loop needs
  `asyncore`, which was removed from the standard library).
- `docker-compose.yml`: Cassandra 5.0 container moved to host port 9043 so it can run beside an
  existing Cassandra on 9042.

### 3. FAISS trainer for the quantizer
- `smdb/quantizer.py`: `trainer="faiss"` option (k-means + product quantizer via faiss-cpu).
- `scripts/bench.py`: `--trainer`, `--k-ivf` flags; line-buffered output.
- Result: k=4096 FAISS centroids, nprobe=1 reaches nDCG@10 0.6654 reading 0.6% of the corpus
  (exact ColBERTv2: 0.6702). Partitions are better balanced than with scikit-learn.
- Result: the joint "mass" planner is no better than the fixed per-token planner (within
  +/-0.005). Not pursued further.

## 2026-10-08

### 4. Baselines
- `scripts/bench_baselines.py`: BM25, exact single-vector retrieval (all-MiniLM-L6-v2,
  bge-base-en-v1.5), optional SAI ANN on Cassandra 5.0.
- Result: BM25 0.6523, MiniLM 0.6451, bge-base 0.7404. Our index (0.665) beats the first two
  and loses to bge-base: the limit is the ColBERTv2 model, not the index.

### 5. Compact layouts and pooling
- `smdb/config.py`: `postings="ids"` (posting rows carry chunk ids only; codes stored once).
- `smdb/pooling.py` (new): hierarchical pooling and centroid pooling (one vector per
  (chunk, centroid)).
- `smdb/index.py`: `pool=` option; ids-mode first stage.
- `smdb/store/memory.py`, `smdb/store/cassandra.py`: support both posting layouts.
- `smdb/encoder.py`: reference ColBERT marker conventions (`markers="colbert"`), any
  Stanford-format checkpoint. *This path has not been run yet.*
- `scripts/bench.py`: reworked sweep (rerank depths, layouts, pooling, model flag, bytes per chunk).
- `scripts/bench_storage.py`, `scripts/bench_reads.py`: representation and read-policy studies.
- `tests/test_core.py`: tests for the above.
- Results (quality ceiling per representation, bytes for one copy):
  all tokens m=32: 9,071 B, 0.6684 | centroid pool m=32: 4,148 B, 0.6660 |
  hierarchical pool x2: 4,540 B, 0.6659 | hierarchical pool x3: 3,041 B, 0.6636 |
  m=16: 4,802 B, 0.6611 | centroid id only: 244 B, 0.5870.
- Result: ids-only postings give a weak first stage (0.617 at 20 fetches); codes in postings
  with centroid pooling give 0.665 at nprobe=2, 50 fetches.

### 6. ColBERT Live! comparison arm
- `scripts/bench_colbertlive.py` (new): our re-implementation of the DataStax ColBERT Live!
  design (float vectors pooled by 2, one SAI ANN query per query vector, exact MaxSim on the
  fetched candidates), on the same cached vectors. `--ann exact` or `--ann sai`.
- `smdb/diskusage.py` (new): on-disk size of a table inside the Cassandra container.

### 7. Fixes found while running on real Cassandra
- `scripts/bench_colbertlive.py`: write concurrency 8 with retries (SAI's graph builder rejects
  writes above ~13 concurrent: "outstanding pooled objects"); `--reuse` to query an already
  loaded table; spot-check instead of `count(*)`; search/fetch latency breakdown.
- `smdb/diskusage.py`: major-compact before measuring; exclude snapshot folders.
- `smdb/store/base.py`, `smdb/store/cassandra.py`: bulk `write_docs` (one concurrent wave per
  batch, one counter update per centroid per batch). Ingest went from 10 to 12 chunks/s: the
  counters were not the bottleneck; row count through the Python driver is.
- `smdb/store/cassandra.py`, `scripts/bench_colbertlive.py`: native protocol v4 (the driver
  intermittently fails with "CRC mismatch on header" on v5).
- `scripts/bench.py`: batched ingest; partition-read / fetch latency breakdown.

### 8. Java 21 container for the SAI baseline
- `docker/Dockerfile.jdk21` (new), `docker-compose.yml` (`cassandra-jdk21`, profile `jdk21`,
  port 9044): Cassandra 5.0.9 on Java 21 with `jdk.incubator.vector`, so jvector can use SIMD.
  Unsupported by Cassandra 5.0; used only to give the baseline its best case.

### Head-to-head result (same Java 21 server, each run alone, tables compacted)

|                              | smdb (centroid pool, nprobe=2) | ColBERT Live! design (n_ann=171) |
|------------------------------|-------------------------------:|---------------------------------:|
| nDCG@10, 50 fetches          | 0.665                          | 0.666                            |
| On disk per chunk            | 10,470 B                       | 170,067 B                        |
| First stage                  | 74 ms (37 partition reads)     | 65 ms (22 ANN queries)           |
| Fetch stage, 50 chunks       | 57 ms                          | 269 ms                           |
| Total latency, 50 fetches    | 208 ms                         | 338 ms                           |
| Ingest                       | 12 chunks/s                    | 10.1 chunks/s                    |

What this supports: equal quality at about 16x less storage, with a cheaper fetch stage, on
plain tables with no vector index. What it does not support: a total-latency or ingest claim.
Timings on this laptop varied by more than 2x between identical runs (the baseline measured
864 ms and 338 ms an hour apart), so only the storage figure and the stage-level pattern are
reliable.

Conditions: our re-implementation of the design, not DataStax's code; open-source Apache
Cassandra 5.0.9, single node in Docker; one dataset.

## 2026-10-09

### 9. Single-copy layout with mixed-precision rescoring
- `smdb/config.py`: `postings="single"`. Posting rows carry the PQ codes; the per-chunk table
  (`doc_tokens`) keeps only the chunk's centroid ids, so codes are stored once.
- `smdb/index.py`: rescoring for this layout. Per query token, the score from stage 1 (best
  match among the chunk's vectors in the partitions that were read, from PQ codes) is combined
  with the best centroid score among the chunk's vectors in unread partitions. No codes are
  fetched in stage 2; the fetch returns about 2 bytes per stored vector.
- `smdb/scorer.py`: `best_by_group` (per-query-token maxima before summing).
- `smdb/store/memory.py`, `smdb/store/cassandra.py`: write the layout.
- `scripts/bench.py`: `--postings single`. `tests/test_core.py`: test for the layout (exact PQ
  ranking when every partition is read; deletes; retrieval).
- `smdb/store/*.py`: `read_posting_rows` (point reads of single posting rows).
  `smdb/index.py`: `refine=` option that point-reads the unread rows which could change a
  chunk's score. `scripts/bench.py`: `--refine`, `rows` column.
- Result on SciFact (centroid pool, nprobe=2, 50 fetches; two-copy layout = 0.6647 at 8,982 B):

  | variant                         | bytes/chunk | extra row reads/query | nDCG@10 |
  |---------------------------------|------------:|----------------------:|--------:|
  | single, centroid-only for unread | 5,079      | 0                     | 0.6512  |
  | single, refine slack -0.05       | 5,079      | 1,051                 | 0.6580  |
  | single, refine slack 0           | 5,079      | 2,475                 | 0.6587  |
  | single, refine slack 0.1         | 5,079      | 5,662                 | 0.6633  |

- **Verdict: not adopted.** Centroid-only scoring of unread vectors costs 1.3 points, and
  recovering it needs thousands of point reads per query. The two-copy layout with centroid
  pooling stays the default. The code is kept behind `postings="single"` as a negative result.

### 10. Model swap: answerdotai/answerai-colbert-small-v1 (96-dim)
- No code change; first real run of `markers="colbert"` and of a non-default checkpoint
  (`--model answerdotai/answerai-colbert-small-v1 --markers colbert`).
- Exact MaxSim reaches nDCG@10 0.7456, in line with the published figure for this model, which
  confirms the encoder follows the reference conventions.
- Index (k=4096 FAISS, centroid pool, two-copy, 8,495 logical B/chunk, 115 vectors/chunk):

  | setting              | reads | nDCG@10 |
  |----------------------|------:|--------:|
  | nprobe=1, 50 fetches |  69.5 | 0.6808  |
  | nprobe=2, 20 fetches |  56.7 | 0.7109  |
  | nprobe=2, 50 fetches |  86.7 | 0.7162  |
  | nprobe=4, 20 fetches |  87.2 | 0.7414  |
  | nprobe=4, 50 fetches | 117.2 | 0.7410  |

- This model needs nprobe=4 to get within 0.005 of exact (ColBERTv2 needed nprobe=1-2), and 20
  fetches are then enough. At that setting the index matches exact bge-base-en-v1.5 (0.7404)
  and is 7.6 points above the ColBERTv2 index (0.665).
- Encoding is about 5x faster than ColBERTv2 on the same CPU (6 min vs 35 min for the corpus).

## 2026-10-10

### 11. PDF textbooks -> section-aware chunks
- `smdb/pdf.py` (new): reads a text PDF with PyMuPDF. The section hierarchy comes from the PDF's
  own outline (font size / weight when there is none); page headers and footers are removed;
  chunks are whole paragraphs packed to about 160 words, never cross a heading, keep code
  blocks whole, and carry chapter, section path, page range and a kind (body / exercise /
  reference). The section path is prepended to the text that gets encoded.
- `scripts/index_book.py` (new): PDF -> chunks -> token vectors -> quantizer trained on the
  book -> index -> questions, with caching. `--encoder hash` runs it without a model.
- `tests/test_pdf.py` (new); `pyproject.toml`: `pdf` extra (pymupdf); `.gitignore`: `books/`.
- Result on Elmasri & Navathe, *Fundamentals of Database Systems* (869 pages, 1,325 outline
  entries): 3,321 chunks in 4 s - 2,582 body, 157 exercise, 582 reference; all 27 chapters and
  4 appendices recovered; no body chunk sits under the wrong chapter; median 122 words.
- *Retrieval on the book with the real model has not been run yet* (only the wiring, with the
  hash encoder). Figures are not extracted (the PDF has none embedded).

- First real run on the book (answerai-colbert-small-v1, 2,048 centroids, centroid pool):
  encoding 2,582 chunks took 190 s (13.6 chunks/s) on CPU, 5,477 bytes per chunk, about 40 ms
  per question including encoding it. Four spot-check questions (two-phase locking, primary vs
  secondary index, third normal form, write-ahead logging) each returned the defining section
  at rank 1 or 2.

### 12. Textbook evaluation from the book's own review questions
- `scripts/eval_book.py` (new): splits the "Review Questions" sections into single questions
  (308 for Elmasri, from 22 chapters) and scores a retrieved chunk as correct when it comes from
  the question's chapter. Compares BM25, exact ColBERT MaxSim, the index at several settings,
  and optional exact single-vector models. The question chunks are never in the index.
- Chapter-level labels are coarse, and review questions reuse the book's wording, which favours
  keyword search; read the numbers with that in mind.
- Result (Elmasri, 2,582 body chunks, 308 questions, chance = 3.6%):

  | system                              | top-1 | P@5   | any@5 | bytes/chunk |
  |-------------------------------------|------:|------:|------:|------------:|
  | BM25                                | 0.880 | 0.752 | 0.981 | -           |
  | all-MiniLM-L6-v2, exact             | 0.886 | 0.791 | 0.977 | 1,536       |
  | smdb index, nprobe=1, 20 fetches    | 0.896 | 0.777 | 0.964 | 5,477       |
  | smdb index, nprobe=4, 20 fetches    | 0.899 | 0.812 | 0.974 | 5,477       |
  | smdb index, nprobe=8, 20 fetches    | 0.906 | 0.823 | 0.981 | 5,477       |
  | ColBERT exact MaxSim (ceiling)      | 0.932 | 0.840 | 0.981 | 60,657      |

- Reading: with 308 questions the top-1 differences between BM25, MiniLM and the index (about
  0.02) are within sampling noise. The index is ahead on P@5 (0.81-0.82 against 0.75 and 0.79).
  It sits about 3 points below its own exact ceiling on top-1, a larger gap than on SciFact.
  Every system is near 90%, so this test is too easy to separate them well.

### 13. Full head-to-head on the textbook, on Cassandra
- `scripts/eval_book.py`: `--colbertlive` (the ColBERT Live! design on the same vectors, brute-force
  ANN = its best case), `--cassandra` (both systems on one Cassandra 5.0.9 / Java 21 container:
  timed load, on-disk size after compaction, query passes interleaved between the two systems,
  medians over 2 passes), `--pool`.
- Result (Elmasri, 2,582 chunks, 308 review questions, answerai-colbert-small-v1):

  |                              | smdb, nprobe=4 | smdb, nprobe=8 | ColBERT Live!, 20 fetches | ColBERT Live!, 50 fetches |
  |------------------------------|---------------:|---------------:|--------------------------:|--------------------------:|
  | top-1 from the right chapter | 0.899          | 0.906          | 0.925                     | 0.935                     |
  | share of top 5 correct       | 0.812          | 0.823          | 0.799                     | 0.815                     |
  | on disk per chunk            | 6,689 B        | 6,689 B        | 79,398 B                  | 79,398 B                  |
  | ingest into Cassandra        | 70.3 chunks/s  | 70.3 chunks/s  | 26.5 chunks/s             | 26.5 chunks/s             |
  | query latency (median)       | 65 ms          | 93 ms          | 108 ms                    | 199 ms                    |
  | - first stage                | 38 ms          | 58 ms          | 40 ms                     | 41 ms                     |
  | - fetch stage                | 16 ms          | 16 ms          | 67 ms                     | 155 ms                    |

- Reading: 11.9x less disk, 2.7x faster ingest, 1.7-3x lower latency (all of it from the fetch
  stage; the first stages are equal), equal top-5 precision, and 2.6-3 points lower top-1. The
  top-1 gap is the cost of ranking from compressed codes instead of full vectors; it did not
  appear on SciFact with ColBERTv2.
- Conditions: single run on a laptop; our re-implementation of the design; chapter-level labels.
- Follow-up on the top-1 gap (in memory, 50 fetches):

  | variant                       | logical B/chunk | top-1 (nprobe 4 / 8) | P@5 (nprobe 4 / 8) |
  |-------------------------------|----------------:|---------------------:|-------------------:|
  | centroid pool, 20 fetches     | 5,477           | 0.899 / 0.906        | 0.812 / 0.823      |
  | centroid pool, 50 fetches     | 5,477           | 0.899 / 0.906        | 0.816 / 0.823      |
  | no pooling, 50 fetches        | 10,425          | 0.919 / 0.922        | 0.823 / 0.830      |

  Fetching more candidates does nothing; the gap comes from pooling. Without pooling the index
  is within about 1 point of the ColBERT Live! design (0.925-0.935) at about a third of its
  raw size. So pooling is a setting: compact (about 12x less disk, -3 points top-1) or
  accurate (about 6x less disk by estimate, -1 point). The no-pooling layout has not been
  measured on Cassandra for this book.

### 14. Targeted prior-art search on centroid-aligned pooling
- `docs/prior_art.md` (new). Main finding: ColBERTSaR (SIGIR 2026, arXiv:2606.05568, June 2026)
  already represents a passage as the set of distinct centroids its tokens map to, in a
  centroid-keyed inverted index, without residuals. That anticipates "one entry per
  (document, centroid)". What we add - a pooled residual PQ code per entry, a small codebook,
  the wide-column layout - is an increment over it. Patent databases not yet searched.

### 15. StudyMate integration
- This repo: `smdb/service.py` (`SMDB_POOL`, pool reported by `/health`), `smdb/cli.py`
  (`load --file` stores an already trained quantizer), `scripts/run_sidecar.ps1` (stores the
  quantizer if missing, then starts the sidecar with answerai-colbert-small-v1 on port 8100).
- Backend (`studymate-backend`, separate folder):
  - `src/services/retrievalService.js` (new): sidecar client; `buildContext(documentId, question)`
    returns the top chunks when the index has them and the whole document otherwise.
    One index scope per document (`doc:<id>`), chunk ids = `chunk_index`.
  - `src/services/chunker.js` (new): paragraph / sentence-aware chunks of about 160 words,
    replacing fixed 500-character slices.
  - `documents.controller.js`: new chunker; chunks written with concurrent single-row inserts
    (the former single batch exceeded Cassandra's batch size limit beyond a few pages);
    background indexing on upload; index removal on delete; `GET /:id/index-status`.
  - `chat.controller.js`, `evaluation.controller.js`: context from `buildContext`; responses
    carry `retrieval: { mode, sources }`.
  - `server.js` health shows the sidecar; `src/db/reindex.js` + `npm run reindex` for existing
    documents; `.env.example`, `README.md`.
  - Switch: `RETRIEVAL_ENABLED` (default false). Off, unreachable or not-yet-indexed all fall
    back to the old whole-document behaviour.
- Tested here: the Node client against a running sidecar (in-memory store, stand-in encoder),
  with the chunk table faked: index, search, per-document isolation, delete, and every
  fallback path. *Not yet run against the real backend, Cassandra and model.*
- First run on the real stack (2026-10-10): backend health reports the sidecar reachable with
  the real model; `npm run reindex` indexed the 91 existing documents (546 chunks) in 56 s.
- Frontend (`studymate-frontend`, separate folder): `Sources` component in `components/ui.jsx`
  (expandable list of the passages an answer is based on, or a note that the whole document
  was used); shown under bot messages in `Chat.jsx` and under the result in `Evaluator.jsx`;
  `Documents.jsx` shows indexing progress for a new upload; `AppShell.jsx` shows whether
  focused retrieval is on; `api/endpoints.js` gains `getIndexStatus` and `getHealth`.
  Syntax-checked only; *not yet run in the browser.*
- Frontend comparison modal: `components/BenchmarkModal.jsx` + `data/benchmark.json`, opened
  from the Documents page ("How it's indexed"). Shows disk per chunk, write speed, query time
  and accuracy for Cassandra single-vector search, the ColBERT Live! design and this index,
  from the measured figures in entry 13. Unmeasured values display as "not measured".
- `scripts/eval_book.py`: with `--cassandra --single <model>` it now also loads the
  single-vector embeddings into a SAI table and measures ingest, disk and latency, to fill the
  first column of that modal. *Not yet run.*
- Live three-way comparison (requested as a real-time view, not a static benchmark):
  - `smdb/compare.py` (new) + `POST /compare`, `GET /compare/{job}` in `smdb/service.py`: indexes
    the given chunks as (1) one MiniLM vector per chunk in a SAI table, (2) the ColBERT Live!
    design in a SAI table, (3) this index, one after another, really encoding and really
    writing each, and reports progress, encode time, write time, rows and bytes written.
    Writes go to a separate Cassandra 5.0 (`SMDB_COMPARE_PORT`, default 9044) and are removed
    afterwards. Capped at 300 chunks per run. `tests/test_service.py` covers the job flow with
    an in-memory sink.
  - Backend: `POST /api/documents/:id/compare`, `GET /api/documents/compare/:jobId`.
  - Frontend: `components/LiveCompareModal.jsx`, opened by "Compare indexing" on a document
    card; polls every 0.6 s and shows per-system progress, upload speed, time and footprint,
    then a summary with bar charts. The static book benchmark is one click behind it.
  - Footprint in this view is bytes handed to the database, not on-disk size, which cannot be
    read per document from a running Cassandra; the modal says so.
  - *The Cassandra/SAI path of the comparison has not been run yet* (tested with the in-memory
    sink and stand-in encoders only).
- First live comparison run on the real stack (300 chunks of a 3,019-chunk upload): single
  vector 25.5 s / 463 KB; ColBERT Live! design 81 s / 12.3 MB; this index 85 s / 2.4 MB.
  Encoding is 70-80% of the time for both multi-vector systems, so end-to-end upload speed is
  the same (3.7 vs 3.5 chunks/s); writes alone are 1.3x faster for this index and it stores
  5.2x less. Single-vector search is 3x faster and 5x smaller than this index.
- Quality in the live comparison (so the view is not only about cost):
  - `smdb/compare.py`: the three indexes now stay alive after the run. `search` runs one
    question through all three and returns each one's top passages and time; `sample` +
    `selftest` implement a known-item test (questions written for specific chunks; a system
    scores when it returns that chunk first / in its top 5); `close` removes the data, and a
    running job can be cancelled. One live comparison at a time. Service routes
    `/compare/{job}/search|sample|selftest`, `DELETE /compare/{job}`.
  - Backend: `llmService.questionForPassage` (no fallback; needs a real provider),
    `POST /api/documents/compare/:jobId/search`, `.../selftest` (LLM writes one question for
    each of 20 sampled chunks), `DELETE /api/documents/compare/:jobId`.
  - Frontend `LiveCompareModal.jsx`: a Quality section with an ask-all-three box (top 3
    passages per system, marking passages only one system found) and a self-test with
    first-place and top-5 rates plus the per-question ranks. Percentage bars use a fixed
    0-100 scale.
  - The self-test reports whatever it measures; with 20 questions one question is 5 points.
  - *Search and self-test against real Cassandra/SAI and a real LLM have not been run yet.*
- Chat follow-ups: `chat.controller.js` passes the last six messages to the LLM and searches a
  follow-up ("elaborate", "explain that") together with the previous question;
  `llmService.answerQuestion` takes the history and may elaborate on the context.
- Quiz generation review (`llmService.js`, `quiz.controller.js`, frontend `Quiz.jsx`):
  - the whole document was sent to the LLM, which fails for long documents; now a short
    document goes in whole and a long one as passages spread through it (about 2,500 words),
    or the passages retrieved for an optional topic;
  - provider errors (HTTP status and message) are logged and reported instead of silently
    producing placeholder questions; the response carries `aiGenerated`, `notice`, `source`;
  - model output is parsed tolerantly and validated: options de-duplicated, the answer mapped
    to an option when given as a letter, questions that cannot be graded dropped;
  - output length scales with the number of questions (was fixed at 1,024 tokens).
  *Not yet run against the configured provider.*
- Topic quiz returned an off-topic question (TF-IDF for the topic "normalization"). Causes: a
  one-word query is ambiguous to any retriever; the LLM was not told the topic; a fixed number
  of passages was always returned; and browser-uploaded PDFs had lost their section headings.
  Changes:
  - `llmService.generateQuiz(text, n, topic)`: the model is given the topic, told to ignore
    passages that only share a word with it, and to return fewer questions rather than pad.
  - `retrievalService.search(..., focused)`: optional relevance cut-off (scores scaled between
    the 30th result and the best; keep those in the upper half, at least 3, at most k). Used by
    topic quizzes. A heuristic on relative scores; *not validated on labelled data.*
  - PDFs keep their structure: sidecar `POST /extract` (smdb/pdf.py) returns chunks with
    section path, page range and section-prefixed `indexed_text`; backend
    `POST /api/documents/upload` (multer) stores `section` and the real `page_number` and indexes
    the section-prefixed text; plain-text fallback via pdf-parse when the sidecar cannot read
    the file. `document_chunks.section` added (schema.cql + additive migration on start).
    Sources in chat / evaluator / quiz show "section · p.N"; the LLM context labels each passage.
    `reindex.js` keeps the section prefix. Frontend sends the file instead of extracting text
    in the browser (browser extraction kept only for an older backend).
  - Checked here: `/extract` on the Elmasri PDF through the Node client returns 2,739 chunks
    with sections and pages. *Upload route, migration and cut-off not yet run on the real stack.*
  - Documents uploaded before this change have no sections; re-upload them to get the benefit.
- Upload progress appeared stuck at 2400/3173 chunks. The progress note in `Documents.jsx`
  stopped polling after 15 minutes, less than a whole textbook takes, so the number froze while
  indexing carried on. Fixes: the note now polls until indexing ends and resumes after a page
  reload (`GET /api/documents/indexing`); the backend logs duration and the point of any
  failure, and retries a failed batch once; new uploads use a bulk write path on the sidecar
  (`/index` with `replace: false`), skipping a per-chunk existence check. Indexing status is
  still held in the backend's memory: restarting the backend mid-way leaves a document partly
  indexed until `npm run reindex`.
- Known limit: the sidecar's quantizer was trained on one database textbook; documents on
  very different subjects will compress less well until it is retrained on mixed material.

---

## Open items
- Ingest: group rows by partition into one write. Not built.
- Passage-level judging of a sample of textbook questions. Not started.
- StudyMate: check the frontend changes in the browser; set a real LLM provider for the demo.

- **Quiz review, round 3 (backend).** Topic quiz with 15 questions now uses 8 passages and returned 14 on-topic
  questions. Two flaws seen in that output and fixed in `llmService.js`: the correct option was listed first in 11 of
  14 questions (options are now shuffled after parsing), and several questions repeated the same fact (prompt now
  forbids asking the same thing twice). `quiz.controller.js` logs passages wanted/used per topic quiz.

- **Hosting from the laptop.** Backend now serves the built frontend (`server.js`, `FRONTEND_DIR`), frontend
  production build calls the API on its own address (`client.js`, `.env.production`), and `studymate-backend/host.ps1`
  + `HOSTING.md` open a Cloudflare quick tunnel on port 4000. Not yet run end to end.

- **Self-test with detail questions.** `questionForPassage(passage, kind)` gains a `detail` kind (asks about one
  specific point inside the passage, not its main subject). The self-test alternates detail/general by position,
  before any index is asked, and reports first / top-5 per kind (`documents.controller.js`, `LiveCompareModal.jsx`).
  Not yet run against the real stack.

- **Hosting, auth and admin (backend + frontend, not yet run on real Cassandra).** 3-node Cassandra image and
  entrypoint for Railway (`studymate-backend/deploy/cassandra`), LOCAL_QUORUM default, keyspace replication from
  `CASSANDRA_REPLICATION`; retrieval sidecar image + `scripts/deploy_sidecar.ps1`, `SMDB_RF`; backend Dockerfile and
  railway.json; Vercel config forwarding `/api/auth/*`. Auth: 15-min access JWT in memory + rotating httpOnly refresh
  cookie (`sessions`, LWT swap, reuse detection), email verification and reset (`auth_tokens`, TTL, Brevo), lockout
  via `login_failures` TTL rows, invite code, password rules. Admin panel (`/api/admin/*`, `pages/Admin.jsx`):
  per-node health from `system_views`, schema + paged row browser with redaction, users (verify / sign out /
  disable), audit log (`admin_audit`), API metrics. Auth flow passes 23 checks against an in-memory stand-in.
