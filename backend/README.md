# StudyMate — Backend

AI-powered study assistant chatbot backend. Node.js + Express + Apache Cassandra (NoSQL).

Features: document upload & chunking, AI **summarization**, document-grounded **Q&A**, **quiz generation**, and an **AI evaluator** that grades free-text answers against the source material.

---

## Prerequisites

- **Node.js** 18+ (tested on v22)
- **Apache Cassandra** running locally (default `127.0.0.1:9042`)
  - Quickest way to run it: `docker run --name cassandra -p 9042:9042 -d cassandra:4.1`
  - Wait ~30–60s for it to fully start before running setup.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env — set JWT_SECRET; optionally set LLM_PROVIDER + LLM_API_KEY

# 3. Create the keyspace, tables, and materialized view
npm run setup-db

# 4. Seed 500+ sample records (users, docs, chunks, chats, quizzes, evaluations)
npm run seed

# 5. Start the API
npm start          # or: npm run dev  (nodemon auto-reload)
```

Server runs at `http://localhost:4000`. Health check: `GET /api/health`.

## AI provider (optional but recommended for the demo)

All four AI features work in a **deterministic fallback mode** with no API key, so
the app runs end-to-end offline. To enable real AI (semantic summaries, answers,
and grading), set in `.env`:

```
LLM_PROVIDER=gemini          # or anthropic | openai | ollama
LLM_API_KEY=your_key_here
LLM_MODEL=gemini-1.5-flash   # optional; sensible default per provider
```

The evaluator returns `aiGraded: true` in its response when a real provider is active,
and `false` when running on the keyword-overlap fallback.

---

## Retrieval sidecar (optional)

By default, a question about a document sends **every chunk** of that document to the LLM.
With the retrieval sidecar enabled, chat and the evaluator send only the **few chunks relevant
to the question**. The sidecar is a small Python service (the StudyMateDb repository) that keeps
a compressed late-interaction (ColBERT) index in Cassandra, in its own keyspace `smdb`.

```
# in the StudyMateDb repository (starts the sidecar on http://127.0.0.1:8100)
powershell -ExecutionPolicy Bypass -File scripts\run_sidecar.ps1

# in this repository: set in .env, then restart the API
RETRIEVAL_ENABLED=true

# once, to make documents that already exist searchable
npm run reindex
```

- New uploads are indexed in the background; `GET /api/documents/:id/index-status` shows progress.
- Chat and evaluator responses include `retrieval: { mode, sources }`. `mode` is `retrieval`
  when the context came from the index and `full-document` when it fell back.
- **Nothing breaks without it**: if `RETRIEVAL_ENABLED` is false, the sidecar is down, or a
  document is not indexed yet, the app uses the whole document exactly as before.
- Summaries and quiz generation still read the whole document, since they have no question
  to retrieve for.

---

## API reference

All routes except `/api/auth/*` require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Body |
|--------|------|------|
| POST | `/api/auth/register` | `{ name, email, password }` |
| POST | `/api/auth/login` | `{ email, password }` |

### Documents
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/documents` | `{ title, subject, text, fileUrl }` — stores + chunks |
| POST | `/api/documents/upload` | multipart `file` (PDF), `title`, `subject` — keeps chapters, sections and page numbers via the sidecar; falls back to plain text |
| GET | `/api/documents` | list current user's documents |
| GET | `/api/documents/:documentId` | fetch chunks in order |
| GET | `/api/documents/:documentId/index-status` | retrieval indexing progress for this document |
| POST | `/api/documents/:documentId/compare` | start a live three-way indexing comparison (needs the sidecar and a Cassandra 5.0 on port 9044) |
| GET | `/api/documents/compare/:jobId` | live progress and results of that comparison |
| PUT | `/api/documents/:documentId` | `{ uploadedAt, title, subject }` |
| DELETE | `/api/documents/:documentId` | `{ uploadedAt }` |
| POST | `/api/documents/:documentId/summarize` | AI summary |

### Chat (Q&A)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/chat/sessions` | `{ documentId, title }` |
| GET | `/api/chat/sessions` | list sessions |
| GET | `/api/chat/sessions/:sessionId/messages` | messages, chronological |
| POST | `/api/chat/sessions/:sessionId/messages` | `{ text, documentId }` — grounded answer |

### Quizzes
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/quizzes/documents/:documentId/generate` | `{ numQuestions }` |
| GET | `/api/quizzes/documents/:documentId` | list quizzes |
| POST | `/api/quizzes/documents/:documentId/quizzes/:quizId/attempt` | `{ answers: [] }` |
| GET | `/api/quizzes/attempts` | attempt history (dashboard) |

### AI Evaluator
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/evaluations` | `{ documentId, question, studentAnswer, maxScore }` — grades answer |
| GET | `/api/evaluations` | evaluation history (dashboard) |
| GET | `/api/evaluations/one?evaluatedAt=...&evaluationId=...` | single evaluation |

### Analytics (read-heavy / dashboards)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/analytics/dashboard` | **Report 1**: totals (counters) + avg quiz/eval scores (single-partition aggregates) |
| GET | `/api/analytics/subjects` | **Report 2**: per-subject quiz % and eval averages (counter rollups) |
| GET | `/api/analytics/activity?limit=20` | recent activity timeline (fan-in on write) |
| GET | `/api/analytics/leaderboard?limit=10` | top students, ranked (pre-sorted partition) |
| GET | `/api/analytics/weak-topics?threshold=50` | subjects below a score threshold (subquery/HAVING equivalent) |
| POST | `/api/analytics/leaderboard/recompute` | rebuild the leaderboard |

---

## Project structure

```
src/
├── server.js                 # entry point, route wiring
├── config/cassandra.js       # DB connection (singleton client)
├── db/
│   ├── schema.cql            # keyspace + tables + materialized view (DDL)
│   ├── setupSchema.js        # runs the DDL
│   ├── seed.js               # 500+ sample records
│   └── reindex.js            # push existing documents to the retrieval sidecar
├── middleware/auth.js        # JWT verification
├── services/
│   ├── llmService.js         # AI: summarize / answer / quiz / evaluate (+ fallbacks)
│   ├── chunker.js            # paragraph / sentence-aware chunking
│   ├── retrievalService.js   # retrieval sidecar client + context building (+ fallback)
│   └── analyticsWrites.js    # write-time maintenance of counters / feed / rollups
├── controllers/              # request handlers per feature (incl. analytics)
└── routes/                   # express routers per feature (incl. analytics)
```

## Notes for evaluation (rubric mapping)

- **NoSQL design**: query-driven, denormalized wide-column tables; partition/clustering
  keys chosen per access pattern (see `schema.cql`).
- **Read-heavy features (the Cassandra way)**: aggregation is pushed to *write* time so
  every dashboard read is a single-partition lookup —
  - `user_stats` / `user_subject_stats` are **counter tables** (running totals, and
    sums+counts from which averages are computed as `sum / count`);
  - `activity_feed` is a **fan-in-on-write** timeline (one ordered partition read);
  - `leaderboard` is a **pre-sorted partition** for ranked reads;
  - `document_meta` is a denormalized lookup enabling access by `document_id` alone.
- **Aggregate queries**: `COUNT`/`AVG` used within a single partition
  (`WHERE user_id = ?`) in the dashboard endpoint — efficient because they are not
  full-table scans.
- **Subquery / HAVING equivalent**: `/api/analytics/weak-topics` runs the aggregate
  read then filters the results in the application layer (CQL has neither).
- **Join equivalent**: the dashboard combines `user_stats`, `quiz_attempts` and
  `evaluations` in application code (Cassandra has no joins).
- **Uniqueness constraint equivalent**: email uniqueness via a dual-written
  `users_by_email` lookup table + `IF NOT EXISTS` lightweight transaction on register.
  (A materialized view was avoided deliberately — MVs are experimental and disabled
  by default in Cassandra 4.x.)
- **Atomic multi-row writes**: `client.batch()` for message pairs and document chunks
  (NoSQL equivalent of a transaction).
- **≥500 records**: `npm run seed` inserts several thousand rows across 15 tables.
- **CRUD + DB connectivity**: full create/read/update/delete on documents, chat,
  quizzes, and evaluations, plus the analytics read layer.

## Test login (after seeding)

Seeded users use email `student1@studymate.edu` … `student30@studymate.edu`,
all with password `password123`.
