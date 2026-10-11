/**
 * quiz.controller.js — quiz generation from a document + attempt scoring.
 */
const { v4: uuidv4 } = require('uuid');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const llm = require('../services/llmService');
const analytics = require('../services/analyticsWrites');
const retrieval = require('../services/retrievalService');

const QUIZ_WORD_BUDGET = 2500; // how much of a document is sent to the LLM for one quiz

/**
 * Text to write a quiz from. A short document goes in whole. A long one would overflow the
 * model's input (and cost a lot), so we send a spread of passages instead: evenly spaced
 * through the document, from a random starting point so repeated quizzes differ.
 * With a `topic`, the passages come from the retrieval index instead.
 */
async function quizSource(documentId, topic, numQuestions = 5) {
  if (topic) {
    // cut the list where relevance drops, so loosely related passages are not turned into questions
    // ... but never so few that the model runs out of material: one passage per question asked.
    const minK = Math.max(3, Math.min(15, numQuestions));
    const hit = await retrieval.buildContext(documentId, topic, Math.max(10, minK), { depth: 30, keep: 0.5, minK });
    console.log(`[quiz] topic "${topic}": ${numQuestions} questions asked, at least ${minK} passages wanted, ${hit.chunksUsed} used (${hit.mode})`);
    if (hit.mode === 'retrieval') {
      return { text: hit.context, chunksUsed: hit.chunksUsed, chunksTotal: null, mode: 'topic', passages: hit.sources };
    }
  }
  const rows = await client.execute(
    'SELECT chunk_text FROM document_chunks WHERE document_id = ?',
    [documentId],
    { prepare: true }
  );
  const chunks = rows.rows.map((r) => r.chunk_text || '');
  const wordsOf = (t) => t.split(/\s+/).filter(Boolean).length;
  const total = chunks.reduce((n, c) => n + wordsOf(c), 0);
  if (total <= QUIZ_WORD_BUDGET) {
    return { text: chunks.join('\n\n'), chunksUsed: chunks.length, chunksTotal: chunks.length, mode: 'whole-document' };
  }
  const avg = total / chunks.length;
  const want = Math.max(4, Math.min(chunks.length, Math.floor(QUIZ_WORD_BUDGET / avg)));
  const step = chunks.length / want;
  const offset = Math.random() * step;
  const picked = [];
  for (let i = 0; i < want; i++) picked.push(chunks[Math.min(chunks.length - 1, Math.floor(offset + i * step))]);
  return { text: picked.join('\n\n'), chunksUsed: picked.length, chunksTotal: chunks.length, mode: 'sampled' };
}

// GENERATE quiz from a document's chunks
async function generateQuiz(req, res) {
  try {
    const { documentId } = req.params;
    const { numQuestions, topic } = req.body;
    const count = Math.max(1, Math.min(15, parseInt(numQuestions, 10) || 5));

    const wanted = (topic || '').trim();
    const source = await quizSource(documentId, wanted, count);
    if (!source.text.trim()) return res.status(404).json({ error: 'This document has no text to build a quiz from' });
    // only tell the model about the topic when the passages really came from a topic search
    const quiz = await llm.generateQuiz(source.text, count, source.mode === 'topic' ? wanted : '');

    const subject = await analytics.subjectForDocument(documentId);
    const quizId = uuidv4();
    await client.execute(
      'INSERT INTO quizzes (document_id, quiz_id, subject, questions, options, correct_answers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [types.Uuid.fromString(documentId), quizId, subject,
       quiz.map((q) => q.question),
       quiz.map((q) => q.options),
       quiz.map((q) => q.answer),
       new Date()],
      { prepare: true }
    );

    // return without the answers so the client can present the quiz
    return res.status(201).json({
      quizId,
      documentId,
      questions: quiz.map((q, i) => ({ index: i, question: q.question, options: q.options })),
      aiGenerated: !quiz.fallback,
      notice: quiz.fallback
        ? `Placeholder questions were used because ${quiz.reason}.`
        : quiz.length < count
          ? `Only ${quiz.length} of the ${count} questions asked for could be written from what the document says about this.`
          : wanted && source.mode !== 'topic'
            ? 'The topic could not be searched (retrieval is off or this document is not indexed), so the quiz covers the whole document.'
            : undefined,
      source: {
        mode: source.mode,
        topic: source.mode === 'topic' ? wanted : undefined,
        chunksUsed: source.chunksUsed,
        chunksTotal: source.chunksTotal,
        passages: source.passages,
      },
    });
  } catch (err) {
    console.error('[generateQuiz]', err);
    return res.status(500).json({ error: 'Failed to generate quiz' });
  }
}

// LIST quizzes for a document
async function listQuizzes(req, res) {
  try {
    const { documentId } = req.params;
    const result = await client.execute(
      'SELECT quiz_id, questions, options, created_at FROM quizzes WHERE document_id = ?',
      [documentId],
      { prepare: true }
    );
    return res.json(result.rows.map((r) => ({
      quizId: r.quiz_id.toString(),
      questions: r.questions,
      options: r.options,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('[listQuizzes]', err);
    return res.status(500).json({ error: 'Failed to list quizzes' });
  }
}

// SUBMIT attempt — score against stored answers, record result
async function submitAttempt(req, res) {
  try {
    const { documentId, quizId } = req.params;
    const { answers } = req.body; // array of selected option strings
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an array' });
    }

    const quizRow = await client.execute(
      'SELECT subject, correct_answers FROM quizzes WHERE document_id = ? AND quiz_id = ?',
      [types.Uuid.fromString(documentId), types.Uuid.fromString(quizId)],
      { prepare: true }
    );
    if (quizRow.rowLength === 0) return res.status(404).json({ error: 'Quiz not found' });

    const quizData = quizRow.first();
    const correct = quizData.correct_answers || [];
    const subject = quizData.subject || 'General';
    let score = 0;
    correct.forEach((ans, i) => { if (answers[i] === ans) score++; });

    await client.execute(
      'INSERT INTO quiz_attempts (user_id, attempted_at, attempt_id, quiz_id, score, total_questions) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, new Date(), uuidv4(), types.Uuid.fromString(quizId), score, correct.length],
      { prepare: true }
    );

    // read-heavy table maintenance (totals + per-subject rollup + feed)
    await analytics.onQuizAttempt(req.userId, subject, score, correct.length,
      `Scored ${score}/${correct.length} on a ${subject} quiz`);

    return res.json({ score, total: correct.length });
  } catch (err) {
    console.error('[submitAttempt]', err);
    return res.status(500).json({ error: 'Failed to submit attempt' });
  }
}

// LIST attempts for the dashboard
async function listAttempts(req, res) {
  try {
    const result = await client.execute(
      'SELECT attempted_at, quiz_id, score, total_questions FROM quiz_attempts WHERE user_id = ?',
      [req.userId],
      { prepare: true }
    );
    return res.json(result.rows.map((r) => ({
      attemptedAt: r.attempted_at,
      quizId: r.quiz_id.toString(),
      score: r.score,
      total: r.total_questions,
    })));
  } catch (err) {
    console.error('[listAttempts]', err);
    return res.status(500).json({ error: 'Failed to list attempts' });
  }
}

module.exports = { generateQuiz, listQuizzes, submitAttempt, listAttempts };
