/**
 * analyticsWrites.js — write-time maintenance for the read-heavy tables.
 * Called by the feature controllers after a successful primary write.
 * These are best-effort: a failure here is logged but does not fail the
 * user's main action.
 */
const { v4: uuidv4 } = require('uuid');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');

async function safe(promise, label) {
  try {
    await promise;
  } catch (err) {
    console.error(`[analyticsWrites:${label}]`, err.message);
  }
}

// resolve a document's subject by document_id (via document_meta)
async function subjectForDocument(documentId) {
  if (!documentId) return 'General';
  try {
    const row = await client.execute(
      'SELECT subject FROM document_meta WHERE document_id = ?',
      [typeof documentId === 'string' ? types.Uuid.fromString(documentId) : documentId],
      { prepare: true }
    );
    return row.first()?.subject || 'General';
  } catch {
    return 'General';
  }
}

async function appendActivity(userId, type, description) {
  await safe(
    client.execute(
      'INSERT INTO activity_feed (user_id, event_at, event_id, event_type, description) VALUES (?, ?, ?, ?, ?)',
      [userId, new Date(), uuidv4(), type, description],
      { prepare: true }
    ),
    'activity'
  );
}

async function onDocumentCreated(userId, description) {
  await safe(
    client.execute('UPDATE user_stats SET documents_count = documents_count + 1 WHERE user_id = ?', [userId], { prepare: true }),
    'docCount'
  );
  await appendActivity(userId, 'upload', description);
}

async function onSummaryCreated(userId, description) {
  await safe(
    client.execute('UPDATE user_stats SET summaries_count = summaries_count + 1 WHERE user_id = ?', [userId], { prepare: true }),
    'sumCount'
  );
  await appendActivity(userId, 'summary', description);
}

async function onQuizAttempt(userId, subject, score, total, description) {
  await safe(
    client.execute('UPDATE user_stats SET quizzes_taken = quizzes_taken + 1 WHERE user_id = ?', [userId], { prepare: true }),
    'quizCount'
  );
  await safe(
    client.execute(
      'UPDATE user_subject_stats SET total_quiz_score = total_quiz_score + ?, total_quiz_questions = total_quiz_questions + ?, quiz_attempts = quiz_attempts + 1 WHERE user_id = ? AND subject = ?',
      [types.Long.fromNumber(score), types.Long.fromNumber(total), userId, subject],
      { prepare: true }
    ),
    'quizSubject'
  );
  await appendActivity(userId, 'quiz', description);
}

async function onEvaluation(userId, subject, score, description) {
  await safe(
    client.execute('UPDATE user_stats SET evaluations_done = evaluations_done + 1 WHERE user_id = ?', [userId], { prepare: true }),
    'evalCount'
  );
  await safe(
    client.execute(
      'UPDATE user_subject_stats SET total_eval_score = total_eval_score + ?, eval_count = eval_count + 1 WHERE user_id = ? AND subject = ?',
      [types.Long.fromNumber(score), userId, subject],
      { prepare: true }
    ),
    'evalSubject'
  );
  await appendActivity(userId, 'evaluation', description);
}

async function onChatMessage(userId) {
  await safe(
    client.execute('UPDATE user_stats SET chat_messages_count = chat_messages_count + 1 WHERE user_id = ?', [userId], { prepare: true }),
    'chatCount'
  );
}

module.exports = {
  subjectForDocument,
  onDocumentCreated,
  onSummaryCreated,
  onQuizAttempt,
  onEvaluation,
  onChatMessage,
};
