/**
 * seed.js — populates Cassandra with 500+ sample records across all tables.
 * Run after setup-db:  npm run seed
 *
 * Record budget (well over the 500 minimum required by the rubric):
 *   users            : 30
 *   documents        : 30 users x ~3 docs      ≈ 90
 *   document_chunks  : 90 docs x ~6 chunks     ≈ 540
 *   summaries        : one per doc             ≈ 90
 *   chat_sessions    : ≈ 120
 *   messages         : 120 sessions x ~6       ≈ 720
 *   quizzes          : one per doc             ≈ 90
 *   quiz_attempts    : ≈ 150
 *   evaluations      : ≈ 150   (AI grading feature)
 *   --------------------------------------------------
 *   TOTAL            : ~2000+ records
 */
const { client } = require('../config/cassandra');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const SUBJECTS = ['Database Systems', 'Operating Systems', 'Computer Networks',
  'Machine Learning', 'Data Structures', 'Theory of Computation', 'Software Engineering'];

const CHUNK_SENTENCES = [
  'A partition key determines which node stores a given row in Cassandra.',
  'Clustering columns control the on-disk sort order within a partition.',
  'Denormalization trades storage for read performance by avoiding joins.',
  'Lightweight transactions use IF NOT EXISTS to provide linearizable writes.',
  'A materialized view re-partitions base-table data by an alternate key.',
  'Consistency level controls how many replicas must acknowledge an operation.',
  'The commit log guarantees durability before data is flushed to SSTables.',
  'Compaction merges SSTables and purges tombstones over time.',
  'Wide-column tables model one query each rather than one entity each.',
  'Time-series data fits Cassandra well due to append-heavy write patterns.',
];

const QUESTIONS_POOL = [
  'Explain the role of the partition key in Cassandra.',
  'How do clustering columns affect query results?',
  'Why is denormalization preferred over joins in Cassandra?',
  'Describe how lightweight transactions work.',
  'What problem does a materialized view solve?',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

async function seed() {
  await client.connect();
  console.log('[seed] connected, beginning insert...');

  let counts = { users: 0, documents: 0, chunks: 0, summaries: 0,
    sessions: 0, messages: 0, quizzes: 0, attempts: 0, evaluations: 0,
    document_meta: 0, user_stats: 0, subject_stats: 0, activity: 0, leaderboard: 0 };

  // in-memory rollup accumulators, mirrored into the analytics tables at the end
  // rollup[userId] = { docs, summaries, quizzes, evals, chatMsgs,
  //                    subjects: { [subject]: { qScore, qQ, qAtt, eScore, eCnt } } }
  const rollup = {};
  function R(userId) {
    const k = userId.toString();
    if (!rollup[k]) rollup[k] = { docs: 0, summaries: 0, quizzes: 0, evals: 0, chatMsgs: 0, subjects: {} };
    return rollup[k];
  }
  function S(r, subject) {
    if (!r.subjects[subject]) r.subjects[subject] = { qScore: 0, qQ: 0, qAtt: 0, eScore: 0, eCnt: 0 };
    return r.subjects[subject];
  }
  const activityRows = []; // {userId, at, type, desc}

  const passwordHash = await bcrypt.hash('password123', 10);
  const userIds = [];

  // ---- users ----
  for (let i = 0; i < 30; i++) {
    const userId = uuidv4();
    userIds.push(userId);
    const email = `student${i + 1}@studymate.edu`;
    const name = `Student ${i + 1}`;
    const createdAt = daysAgo(randInt(30, 120));
    await client.execute(
      'INSERT INTO users (user_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, name, email, passwordHash, createdAt],
      { prepare: true }
    );
    // dual-write to the login lookup table
    await client.execute(
      'INSERT INTO users_by_email (email, user_id, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [email, userId, name, passwordHash, createdAt],
      { prepare: true }
    );
    counts.users++;
  }

  // ---- documents + chunks + summaries + quizzes (per user) ----
  const docIndex = []; // {userId, documentId, subject}
  for (const userId of userIds) {
    const numDocs = randInt(2, 4);
    for (let d = 0; d < numDocs; d++) {
      const documentId = uuidv4();
      const subject = pick(SUBJECTS);
      const uploadedAt = daysAgo(randInt(1, 60));
      docIndex.push({ userId, documentId, subject });

      await client.execute(
        'INSERT INTO documents (user_id, uploaded_at, document_id, title, subject, file_url, page_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, uploadedAt, documentId, `${subject} - Unit ${d + 1}`, subject,
         `/uploads/${documentId}.pdf`, randInt(5, 40)],
        { prepare: true }
      );
      counts.documents++;

      // document_meta (lookup-by-id)
      await client.execute(
        'INSERT INTO document_meta (document_id, user_id, title, subject, uploaded_at) VALUES (?, ?, ?, ?, ?)',
        [documentId, userId, `${subject} - Unit ${d + 1}`, subject, uploadedAt],
        { prepare: true }
      );
      counts.document_meta++;
      R(userId).docs++;
      activityRows.push({ userId, at: uploadedAt, type: 'upload', desc: `Uploaded "${subject} - Unit ${d + 1}"` });

      // chunks
      const numChunks = randInt(5, 7);
      for (let c = 0; c < numChunks; c++) {
        await client.execute(
          'INSERT INTO document_chunks (document_id, chunk_index, chunk_text, page_number) VALUES (?, ?, ?, ?)',
          [documentId, c, pick(CHUNK_SENTENCES) + ' ' + pick(CHUNK_SENTENCES), randInt(1, 40)],
          { prepare: true }
        );
        counts.chunks++;
      }

      // summary
      await client.execute(
        'INSERT INTO summaries (document_id, summary_text, generated_at) VALUES (?, ?, ?)',
        [documentId, `Key points for ${subject}: ` + CHUNK_SENTENCES.slice(0, 3).join(' '), new Date()],
        { prepare: true }
      );
      counts.summaries++;
      R(userId).summaries++;

      // quiz (now carries subject)
      const quizId = uuidv4();
      await client.execute(
        'INSERT INTO quizzes (document_id, quiz_id, subject, questions, options, correct_answers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [documentId, quizId, subject,
          ['What determines row placement in Cassandra?', 'What controls sort order within a partition?'],
          [['Partition key', 'Clustering key', 'Secondary index', 'Token'],
           ['Partition key', 'Clustering key', 'Replication factor', 'Snitch']],
          ['Partition key', 'Clustering key'],
          new Date()],
        { prepare: true }
      );
      counts.quizzes++;
    }
  }

  // ---- chat_sessions + messages ----
  for (const userId of userIds) {
    const userDocs = docIndex.filter((x) => x.userId === userId);
    const numSessions = randInt(3, 5);
    for (let sIdx = 0; sIdx < numSessions; sIdx++) {
      const sessionId = uuidv4();
      const startedAt = daysAgo(randInt(1, 30));
      const doc = pick(userDocs) || {};
      await client.execute(
        'INSERT INTO chat_sessions (user_id, started_at, session_id, document_id, title) VALUES (?, ?, ?, ?, ?)',
        [userId, startedAt, sessionId, doc.documentId || uuidv4(), `Study session ${sIdx + 1}`],
        { prepare: true }
      );
      counts.sessions++;

      const numMsgs = randInt(4, 8);
      let t = startedAt.getTime();
      for (let m = 0; m < numMsgs; m++) {
        t += randInt(5000, 60000);
        const isUser = m % 2 === 0;
        await client.execute(
          'INSERT INTO messages (session_id, sent_at, message_id, sender, message_text) VALUES (?, ?, ?, ?, ?)',
          [sessionId, new Date(t), uuidv4(), isUser ? 'user' : 'bot',
           isUser ? pick(QUESTIONS_POOL) : 'Based on your notes: ' + pick(CHUNK_SENTENCES)],
          { prepare: true }
        );
        counts.messages++;
        if (isUser) R(userId).chatMsgs++;
      }
    }
  }

  // ---- quiz_attempts ----
  for (const userId of userIds) {
    const userDocs = docIndex.filter((x) => x.userId === userId);
    const numAttempts = randInt(3, 6);
    for (let a = 0; a < numAttempts; a++) {
      const total = randInt(5, 10);
      const score = randInt(2, total);
      const subject = (pick(userDocs) || {}).subject || pick(SUBJECTS);
      await client.execute(
        'INSERT INTO quiz_attempts (user_id, attempted_at, attempt_id, quiz_id, score, total_questions) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, daysAgo(randInt(1, 25)), uuidv4(), uuidv4(), score, total],
        { prepare: true }
      );
      counts.attempts++;
      const r = R(userId); r.quizzes++;
      const ss = S(r, subject); ss.qScore += score; ss.qQ += total; ss.qAtt += 1;
    }
  }

  // ---- evaluations (AI grading feature) ----
  for (const userId of userIds) {
    const userDocs = docIndex.filter((x) => x.userId === userId);
    const numEvals = randInt(3, 6);
    for (let e = 0; e < numEvals; e++) {
      const doc = pick(userDocs) || {};
      const subject = doc.subject || pick(SUBJECTS);
      const maxScore = 10;
      const score = randInt(3, 10);
      const at = daysAgo(randInt(1, 25));
      let feedback;
      if (score >= 8) feedback = 'Strong answer — covers most key points from the source material.';
      else if (score >= 5) feedback = 'Partially correct — some relevant points, but key ideas are missing.';
      else feedback = 'Answer misses most core concepts. Review the notes and address the main ideas.';
      await client.execute(
        'INSERT INTO evaluations (user_id, evaluated_at, evaluation_id, document_id, question, student_answer, ai_score, max_score, feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, at, uuidv4(), doc.documentId || uuidv4(),
         pick(QUESTIONS_POOL), 'The student wrote an explanation touching on partition keys and sorting.',
         score, maxScore, feedback],
        { prepare: true }
      );
      counts.evaluations++;
      const r = R(userId); r.evals++;
      const ss = S(r, subject); ss.eScore += score; ss.eCnt += 1;
      activityRows.push({ userId, at, type: 'evaluation', desc: `Answer graded ${score}/${maxScore} in ${subject}` });
    }
  }

  // ============================================================
  // Populate READ-HEAVY / ANALYTICS tables from the accumulated rollups
  // ============================================================

  // ---- user_stats (counters) ----
  for (const userId of userIds) {
    const r = R(userId);
    await client.execute(
      'UPDATE user_stats SET documents_count = documents_count + ?, summaries_count = summaries_count + ?, quizzes_taken = quizzes_taken + ?, evaluations_done = evaluations_done + ?, chat_messages_count = chat_messages_count + ? WHERE user_id = ?',
      [long(r.docs), long(r.summaries), long(r.quizzes), long(r.evals), long(r.chatMsgs), userId],
      { prepare: true }
    );
    counts.user_stats++;
  }

  // ---- user_subject_stats (counter rollups) ----
  for (const userId of userIds) {
    const r = R(userId);
    for (const [subject, ss] of Object.entries(r.subjects)) {
      await client.execute(
        'UPDATE user_subject_stats SET total_quiz_score = total_quiz_score + ?, total_quiz_questions = total_quiz_questions + ?, quiz_attempts = quiz_attempts + ?, total_eval_score = total_eval_score + ?, eval_count = eval_count + ? WHERE user_id = ? AND subject = ?',
        [long(ss.qScore), long(ss.qQ), long(ss.qAtt), long(ss.eScore), long(ss.eCnt), userId, subject],
        { prepare: true }
      );
      counts.subject_stats++;
    }
  }

  // ---- activity_feed ----
  for (const row of activityRows) {
    await client.execute(
      'INSERT INTO activity_feed (user_id, event_at, event_id, event_type, description) VALUES (?, ?, ?, ?, ?)',
      [row.userId, row.at, uuidv4(), row.type, row.desc],
      { prepare: true }
    );
    counts.activity++;
  }

  // ---- leaderboard (all-time, ranked by avg quiz %) ----
  for (const userId of userIds) {
    const r = R(userId);
    let qScore = 0, qQ = 0;
    for (const ss of Object.values(r.subjects)) { qScore += ss.qScore; qQ += ss.qQ; }
    const avgPct = qQ > 0 ? Math.round((qScore / qQ) * 100) : 0;
    const idx = userIds.indexOf(userId);
    await client.execute(
      'INSERT INTO leaderboard (bucket, avg_score, user_id, name) VALUES (?, ?, ?, ?)',
      ['all-time', avgPct, userId, `Student ${idx + 1}`],
      { prepare: true }
    );
    counts.leaderboard++;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log('[seed] inserted:', counts);
  console.log(`[seed] TOTAL records: ${total}`);
  await client.shutdown();
}

// counter columns require the bigint/Long type in the driver
const { types } = require('cassandra-driver');
function long(n) { return types.Long.fromNumber(n || 0); }

seed().catch((e) => { console.error(e); process.exit(1); });
