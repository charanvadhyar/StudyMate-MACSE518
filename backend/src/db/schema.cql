-- ============================================================
-- StudyMate :: Apache Cassandra schema (CQL DDL)
-- Query-driven, denormalized wide-column design.
-- ============================================================

CREATE KEYSPACE IF NOT EXISTS studymate
WITH replication = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

USE studymate;

-- ---- users -------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id       uuid,
    name          text,
    email         text,
    password_hash text,
    created_at    timestamp,
    email_verified boolean,
    disabled      boolean,
    PRIMARY KEY (user_id)
);

-- Denormalized lookup table for login-by-email.
-- (A materialized view would work too, but MVs are experimental and
--  DISABLED BY DEFAULT in Cassandra 4.x, so a manually-maintained lookup
--  table is the reliable, recommended pattern. It is dual-written on
--  registration and guards email uniqueness via IF NOT EXISTS.)
CREATE TABLE IF NOT EXISTS users_by_email (
    email         text,
    user_id       uuid,
    name          text,
    password_hash text,
    created_at    timestamp,
    email_verified boolean,
    disabled      boolean,
    PRIMARY KEY (email)
);

-- ---- sessions (one per signed-in device) -------------------
-- The browser holds "<session_id>.<secret>" in an httpOnly cookie, only a SHA-256 of the
-- secret is stored. Every refresh replaces the secret with a lightweight transaction
-- (UPDATE ... IF refresh_hash = <old>), so a stolen, already-used secret is detected and the
-- session is ended. Logout deletes the row. Rows expire after 30 days on their own (TTL).
CREATE TABLE IF NOT EXISTS sessions (
    session_id    uuid PRIMARY KEY,
    user_id       uuid,
    refresh_hash  text,
    created_at    timestamp,
    last_used_at  timestamp,
    user_agent    text
) WITH default_time_to_live = 2592000;

-- all sessions of one user in one partition: "sign out everywhere" and password reset
CREATE TABLE IF NOT EXISTS sessions_by_user (
    user_id     uuid,
    session_id  uuid,
    created_at  timestamp,
    user_agent  text,
    PRIMARY KEY (user_id, session_id)
) WITH default_time_to_live = 2592000;

-- one-time links for email verification and password reset, stored hashed,
-- each row is written with its own TTL (24 h / 1 h) and deleted when used
CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash  text PRIMARY KEY,
    purpose     text,
    user_id     uuid,
    email       text,
    created_at  timestamp
);

-- failed logins per email for the last 15 minutes: the TTL removes old rows, so
-- counting the partition is the number of recent failures (lockout after 5)
CREATE TABLE IF NOT EXISTS login_failures (
    email      text,
    failed_at  timeuuid,
    ip         text,
    PRIMARY KEY (email, failed_at)
) WITH CLUSTERING ORDER BY (failed_at DESC) AND default_time_to_live = 900;

-- admin actions, one partition per day, newest first, kept 90 days
CREATE TABLE IF NOT EXISTS admin_audit (
    day          text,
    at           timeuuid,
    admin_email  text,
    action       text,
    target       text,
    detail       text,
    PRIMARY KEY (day, at)
) WITH CLUSTERING ORDER BY (at DESC) AND default_time_to_live = 7776000;

-- ---- documents ---------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    user_id      uuid,
    uploaded_at  timestamp,
    document_id  uuid,
    title        text,
    subject      text,
    file_url     text,
    page_count   int,
    PRIMARY KEY (user_id, uploaded_at, document_id)
) WITH CLUSTERING ORDER BY (uploaded_at DESC, document_id ASC);

-- ---- document_chunks ---------------------------------------
CREATE TABLE IF NOT EXISTS document_chunks (
    document_id  uuid,
    chunk_index  int,
    chunk_text   text,
    page_number  int,
    section      text,
    PRIMARY KEY (document_id, chunk_index)
) WITH CLUSTERING ORDER BY (chunk_index ASC);

-- ---- summaries ---------------------------------------------
CREATE TABLE IF NOT EXISTS summaries (
    document_id    uuid,
    summary_text   text,
    generated_at   timestamp,
    PRIMARY KEY (document_id)
);

-- ---- chat_sessions -----------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    user_id      uuid,
    started_at   timestamp,
    session_id   uuid,
    document_id  uuid,
    title        text,
    PRIMARY KEY (user_id, started_at, session_id)
) WITH CLUSTERING ORDER BY (started_at DESC, session_id ASC);

-- ---- messages ----------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    session_id    uuid,
    sent_at       timestamp,
    message_id    uuid,
    sender        text,
    message_text  text,
    PRIMARY KEY (session_id, sent_at, message_id)
) WITH CLUSTERING ORDER BY (sent_at ASC, message_id ASC);

-- ---- quizzes -----------------------------------------------
CREATE TABLE IF NOT EXISTS quizzes (
    document_id      uuid,
    quiz_id          uuid,
    subject          text,
    questions        list<text>,
    options          list<frozen<list<text>>>,
    correct_answers  list<text>,
    created_at       timestamp,
    PRIMARY KEY (document_id, quiz_id)
);

-- ---- quiz_attempts -----------------------------------------
CREATE TABLE IF NOT EXISTS quiz_attempts (
    user_id          uuid,
    attempted_at     timestamp,
    attempt_id       uuid,
    quiz_id          uuid,
    score            int,
    total_questions  int,
    PRIMARY KEY (user_id, attempted_at, attempt_id)
) WITH CLUSTERING ORDER BY (attempted_at DESC, attempt_id ASC);

-- ---- evaluations (AI free-text answer grading) -------------
-- Stores an AI-graded open-ended answer: the question, the
-- student's free-text response, an AI score, and AI feedback
-- grounded in the source document. Partitioned by user for the
-- "my evaluation history, newest first" dashboard query.
CREATE TABLE IF NOT EXISTS evaluations (
    user_id        uuid,
    evaluated_at   timestamp,
    evaluation_id  uuid,
    document_id    uuid,
    question       text,
    student_answer text,
    ai_score       int,
    max_score      int,
    feedback       text,
    PRIMARY KEY (user_id, evaluated_at, evaluation_id)
) WITH CLUSTERING ORDER BY (evaluated_at DESC, evaluation_id ASC);

-- ============================================================
-- READ-HEAVY / ANALYTICS TABLES
-- These push aggregation work to WRITE time so every dashboard
-- read is a cheap single-partition lookup (the Cassandra way to
-- serve read-heavy analytical features).
-- ============================================================

-- ---- document_meta -----------------------------------------
-- Lookup document metadata by document_id alone (the base
-- `documents` table is partitioned by user_id, so it cannot be
-- queried by document_id directly). Enables subject/title/owner
-- resolution wherever only a document_id is known.
CREATE TABLE IF NOT EXISTS document_meta (
    document_id  uuid,
    user_id      uuid,
    title        text,
    subject      text,
    uploaded_at  timestamp,
    PRIMARY KEY (document_id)
);

-- ---- user_stats (COUNTER table) ----------------------------
-- Running totals maintained via counter increments on write.
-- A counter table may contain ONLY counter columns besides the
-- primary key. Read = one single-partition lookup.
CREATE TABLE IF NOT EXISTS user_stats (
    user_id              uuid,
    documents_count      counter,
    summaries_count      counter,
    quizzes_taken        counter,
    evaluations_done     counter,
    chat_messages_count  counter,
    PRIMARY KEY (user_id)
);

-- ---- user_subject_stats (COUNTER rollup) -------------------
-- Per-subject sums and counts. Averages are computed at read
-- time as sum / count (the standard Cassandra way to do AVG):
--   avg quiz %   = total_quiz_score  / total_quiz_questions
--   avg eval     = total_eval_score  / eval_count
CREATE TABLE IF NOT EXISTS user_subject_stats (
    user_id               uuid,
    subject               text,
    total_quiz_score      counter,
    total_quiz_questions  counter,
    quiz_attempts         counter,
    total_eval_score      counter,
    eval_count            counter,
    PRIMARY KEY (user_id, subject)
);

-- ---- activity_feed (fan-in on write) -----------------------
-- Every significant action appends one row here, so the whole
-- activity timeline is a single ordered partition read per user.
CREATE TABLE IF NOT EXISTS activity_feed (
    user_id      uuid,
    event_at     timestamp,
    event_id     uuid,
    event_type   text,      -- 'upload' | 'summary' | 'quiz' | 'evaluation'
    description  text,
    PRIMARY KEY (user_id, event_at, event_id)
) WITH CLUSTERING ORDER BY (event_at DESC, event_id ASC);

-- ---- leaderboard -------------------------------------------
-- Cross-user ranking served as a single pre-sorted partition.
-- avg_score is stored as an int (percentage 0-100) so clustering
-- order gives the ranking directly. Maintained by recompute
-- (delete-old-row + insert-new-row when a user's average moves).
CREATE TABLE IF NOT EXISTS leaderboard (
    bucket     text,        -- e.g. 'all-time'
    avg_score  int,
    user_id    uuid,
    name       text,
    PRIMARY KEY (bucket, avg_score, user_id)
) WITH CLUSTERING ORDER BY (avg_score DESC, user_id ASC);
