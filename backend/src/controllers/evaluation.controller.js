/**
 * evaluation.controller.js — the AI EVALUATOR.
 * Grades a student's free-text answer against the source document using the
 * LLM service, then persists the score + feedback to the evaluations table.
 *
 * Flow:
 *   1. Client submits { documentId, question, studentAnswer, maxScore? }
 *   2. Controller pulls the document's chunks as reference context
 *   3. llm.evaluateAnswer() returns { score, maxScore, feedback }
 *   4. Result is stored (partitioned by user for the history dashboard)
 */
const { v4: uuidv4 } = require('uuid');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const llm = require('../services/llmService');
const analytics = require('../services/analyticsWrites');
const retrieval = require('../services/retrievalService');

// EVALUATE — grade a free-text answer
async function evaluateAnswer(req, res) {
  try {
    const userId = req.userId;
    const { documentId, question, studentAnswer, maxScore } = req.body;

    if (!question || !studentAnswer) {
      return res.status(400).json({ error: 'question and studentAnswer are required' });
    }

    // reference context: the chunks of the document relevant to the question (or the whole
    // document when the retrieval index is not available)
    const { context, mode, sources } = await retrieval.buildContext(documentId, question, 6);

    const cap = Number.isInteger(maxScore) ? maxScore : 10;
    const { score, maxScore: outOf, feedback } = await llm.evaluateAnswer(
      question,
      context,
      studentAnswer,
      cap
    );

    const evaluationId = uuidv4();
    const evaluatedAt = new Date();

    await client.execute(
      `INSERT INTO evaluations
        (user_id, evaluated_at, evaluation_id, document_id, question, student_answer, ai_score, max_score, feedback)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, evaluatedAt, evaluationId,
       documentId ? types.Uuid.fromString(documentId) : null,
       question, studentAnswer, score, outOf, feedback],
      { prepare: true }
    );

    // read-heavy table maintenance (totals + per-subject rollup + feed)
    const subject = await analytics.subjectForDocument(documentId);
    await analytics.onEvaluation(userId, subject, score,
      `Answer graded ${score}/${outOf} in ${subject}`);

    return res.status(201).json({
      evaluationId,
      score,
      maxScore: outOf,
      feedback,
      aiGraded: llm.hasRealProvider,
      retrieval: { mode, sources },
    });
  } catch (err) {
    console.error('[evaluateAnswer]', err);
    return res.status(500).json({ error: 'Failed to evaluate answer' });
  }
}

// LIST evaluations — history for the dashboard, newest first
async function listEvaluations(req, res) {
  try {
    const result = await client.execute(
      `SELECT evaluated_at, evaluation_id, document_id, question, student_answer, ai_score, max_score, feedback
        FROM evaluations WHERE user_id = ?`,
      [req.userId],
      { prepare: true }
    );
    return res.json(result.rows.map((r) => ({
      evaluatedAt: r.evaluated_at,
      evaluationId: r.evaluation_id.toString(),
      documentId: r.document_id ? r.document_id.toString() : null,
      question: r.question,
      studentAnswer: r.student_answer,
      score: r.ai_score,
      maxScore: r.max_score,
      feedback: r.feedback,
    })));
  } catch (err) {
    console.error('[listEvaluations]', err);
    return res.status(500).json({ error: 'Failed to list evaluations' });
  }
}

// GET one evaluation by its clustering key
async function getEvaluation(req, res) {
  try {
    const { evaluatedAt, evaluationId } = req.query;
    if (!evaluatedAt || !evaluationId) {
      return res.status(400).json({ error: 'evaluatedAt and evaluationId query params are required' });
    }
    const result = await client.execute(
      `SELECT evaluated_at, evaluation_id, document_id, question, student_answer, ai_score, max_score, feedback
        FROM evaluations WHERE user_id = ? AND evaluated_at = ? AND evaluation_id = ?`,
      [req.userId, new Date(evaluatedAt), types.Uuid.fromString(evaluationId)],
      { prepare: true }
    );
    if (result.rowLength === 0) return res.status(404).json({ error: 'Evaluation not found' });
    const r = result.first();
    return res.json({
      evaluatedAt: r.evaluated_at,
      evaluationId: r.evaluation_id.toString(),
      documentId: r.document_id ? r.document_id.toString() : null,
      question: r.question,
      studentAnswer: r.student_answer,
      score: r.ai_score,
      maxScore: r.max_score,
      feedback: r.feedback,
    });
  } catch (err) {
    console.error('[getEvaluation]', err);
    return res.status(500).json({ error: 'Failed to fetch evaluation' });
  }
}

module.exports = { evaluateAnswer, listEvaluations, getEvaluation };
