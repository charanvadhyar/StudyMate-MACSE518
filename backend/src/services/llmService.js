/**
 * llmService.js
 * Central AI/LLM service for StudyMate's four AI features:
 *   - summarizeText(text)
 *   - answerQuestion(question, context)
 *   - generateQuiz(text, numQuestions)
 *   - evaluateAnswer(question, referenceContext, studentAnswer, maxScore)
 *
 * PROVIDER-AGNOSTIC: set LLM_PROVIDER + LLM_API_KEY in .env to use a real
 * model (Anthropic / OpenAI / Gemini / a local Ollama server). If no API key
 * is configured, each function falls back to a deterministic rule-based
 * implementation so the app still runs end-to-end for development and demos.
 *
 * The fallback for evaluateAnswer does a keyword-overlap score so the grading
 * pipeline, DB writes, and UI can be demonstrated even offline; swap in a real
 * provider for genuine semantic grading.
 */
require('dotenv').config();

const PROVIDER = (process.env.LLM_PROVIDER || 'none').toLowerCase();
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';
const ENDPOINT = process.env.LLM_ENDPOINT || '';

const hasRealProvider = PROVIDER !== 'none' && API_KEY.length > 0;
let lastError = ''; // most recent provider error, for diagnostics

/**
 * Low-level call to a chat-completion style endpoint. Returns plain text.
 * Adjust the request shape per provider. Anthropic shape shown as default.
 */
async function callLLM(systemPrompt, userPrompt, opts = {}) {
  if (!hasRealProvider) {
    throw new Error('NO_PROVIDER'); // signals caller to use fallback
  }
  const maxTokens = opts.maxTokens || 1024;
  // A provider error (bad key, unknown model, rate limit, prompt too long) must not look like
  // an empty answer: log what the provider said and throw, so callers fall back knowingly.
  const fail = async (res) => {
    const body = await res.text().catch(() => '');
    lastError = `${PROVIDER} HTTP ${res.status}: ${body.slice(0, 300)}`;
    console.error('[llm]', lastError);
    throw new Error('LLM_REQUEST_FAILED');
  };

  if (PROVIDER === 'anthropic') {
    const res = await fetch(ENDPOINT || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) await fail(res);
    const data = await res.json();
    return (data.content || []).map((b) => b.text || '').join('\n').trim();
  }

  if (PROVIDER === 'openai') {
    const res = await fetch(ENDPOINT || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) await fail(res);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  if (PROVIDER === 'gemini') {
    const url =
      ENDPOINT ||
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL || 'gemini-1.5-flash'}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      }),
    });
    if (!res.ok) await fail(res);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  // ollama (local) or custom
  const res = await fetch(ENDPOINT || 'http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL || 'llama3',
      prompt: `${systemPrompt}\n\n${userPrompt}`,
      stream: false,
    }),
  });
  if (!res.ok) await fail(res);
  const data = await res.json();
  return (data.response || '').trim();
}

// ---------------------------------------------------------------
// Feature: Summarization
// ---------------------------------------------------------------
async function summarizeText(text) {
  try {
    return await callLLM(
      'You are a study assistant. Summarize the provided class notes concisely into key points a student can revise from.',
      `Summarize the following notes:\n\n${text}`
    );
  } catch {
    // Fallback: first sentences of each paragraph, capped.
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, 5);
    return '[Auto-summary — configure LLM_PROVIDER for AI summaries]\n' + sentences.join(' ');
  }
}

// ---------------------------------------------------------------
// Feature: Document-grounded Q&A
// ---------------------------------------------------------------
/**
 * @param {string} question
 * @param {string} context   passages from the student's notes
 * @param {Array<{sender:string,text:string}>} [history]  earlier turns of this chat, oldest first
 */
async function answerQuestion(question, context, history = []) {
  try {
    const earlier = history.length
      ? `Conversation so far:\n${history
          .map((m) => `${m.sender === 'user' ? 'Student' : 'Assistant'}: ${m.text}`)
          .join('\n')}\n\n`
      : '';
    return await callLLM(
      'You are a study assistant. Answer using the provided context from the student\'s notes. ' +
        'You may explain, rephrase, give examples of, and elaborate on what the context says, and you should use ' +
        'the conversation so far to understand follow-up requests such as "explain more" or "why?". ' +
        'Do not introduce facts that the context does not support. If the context does not cover the question, ' +
        'say which part is missing rather than refusing outright.',
      `Context:\n${context}\n\n${earlier}Question: ${question}`
    );
  } catch {
    // Fallback: return the context sentence most overlapping with the question.
    const qWords = new Set(tokenize(question));
    const best = context
      .split(/(?<=[.!?])\s/)
      .map((s) => ({ s, score: overlap(qWords, tokenize(s)) }))
      .sort((a, b) => b.score - a.score)[0];
    return best
      ? `[Keyword-matched answer — configure LLM_PROVIDER for AI answers]\n${best.s}`
      : 'No relevant content found in the notes.';
  }
}

// ---------------------------------------------------------------
// Feature: Quiz generation
// ---------------------------------------------------------------
/**
 * Pull a JSON array out of a model reply that may wrap it in prose or a code fence.
 */
function extractJsonArray(raw) {
  const clean = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('no JSON array in the reply');
  return JSON.parse(clean.slice(start, end + 1));
}

/**
 * Make model output safe to store and grade: four distinct options, and an answer that is
 * exactly one of them (models sometimes answer with a letter or an index instead).
 */
function normaliseQuiz(parsed, numQuestions) {
  const out = [];
  for (const q of Array.isArray(parsed) ? parsed : []) {
    if (!q || typeof q.question !== 'string') continue;
    const options = [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean))];
    if (options.length < 2) continue;
    let answer = String(q.answer ?? '').trim();
    if (!options.includes(answer)) {
      const letter = answer.match(/^\(?([A-Da-d])\)?[.)]?$/);
      const loose = options.find((o) => o.toLowerCase() === answer.toLowerCase());
      if (letter) answer = options[letter[1].toUpperCase().charCodeAt(0) - 65];
      else if (loose) answer = loose;
      else answer = undefined; // e.g. a bare number: ambiguous (0- or 1-based), so not guessed
    }
    if (!answer) continue; // cannot be graded: leave it out
    // models tend to list the correct option first; shuffle so position gives nothing away
    const shown = options.slice(0, 6);
    if (!shown.includes(answer)) shown[shown.length - 1] = answer;
    for (let i = shown.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shown[i], shown[j]] = [shown[j], shown[i]];
    }
    out.push({ question: q.question.trim(), options: shown, answer });
    if (out.length === numQuestions) break;
  }
  return out;
}

/**
 * @returns {Promise<Array<{question,options,answer}>>} The array carries `fallback: true` when the
 * questions are placeholders (no provider, provider error, or unusable output) and
 * `reason` with a short explanation.
 */
async function generateQuiz(text, numQuestions = 5, topic = '') {
  let reason = 'no LLM provider configured';
  try {
    const raw = await callLLM(
      'You are a quiz generator for students. Return ONLY valid JSON: an array of objects each with "question" (string), ' +
        '"options" (array of exactly 4 distinct strings), and "answer" (string, copied exactly from one of the options). ' +
        'Base every question on the notes provided; test understanding, not trivia about wording. ' +
        'Every question must be answerable from the notes alone: do not use outside knowledge, and do not ask about ' +
        'anything the notes do not state. Exactly one option may be correct; the other three must be clearly wrong ' +
        'according to the notes, not merely less complete. Each question must test a different fact: never ask the ' +
        'same thing twice in different words. No markdown, no prose.' +
        (topic
          ? ` The student asked for a quiz on the topic "${topic}". Every question must be about that topic. The notes were ` +
            'found by an automatic search and some passages may be about something else that merely shares a word with the ' +
            'topic: ignore those passages completely. If the notes support fewer questions on the topic than requested, ' +
            'return fewer rather than padding with off-topic questions.'
          : ''),
      topic
        ? `Topic: ${topic}\n\nGenerate up to ${numQuestions} multiple-choice questions on this topic from these notes:\n\n${text}`
        : `Generate ${numQuestions} multiple-choice questions from these notes:\n\n${text}`,
      { maxTokens: Math.min(4096, 400 + 220 * numQuestions) }
    );
    const quiz = normaliseQuiz(extractJsonArray(raw), numQuestions);
    if (quiz.length) return quiz;
    reason = topic
      ? `the passages found for "${topic}" did not support any questions on it`
      : 'the model returned no usable questions';
  } catch (err) {
    if (err.message !== 'NO_PROVIDER') {
      reason = err.message === 'LLM_REQUEST_FAILED' ? `the LLM request failed (${lastError})` : `could not read the model output (${err.message})`;
      console.error('[generateQuiz]', reason);
    }
  }
  // Fallback: template questions so the pipeline works offline.
  const out = [];
  for (let i = 1; i <= numQuestions; i++) {
    out.push({
      question: `[Sample Q${i}] Which statement best reflects a key concept from this document?`,
      options: ['Concept A', 'Concept B', 'Concept C', 'Concept D'],
      answer: 'Concept A',
    });
  }
  out.fallback = true;
  out.reason = reason;
  return out;
}

// ---------------------------------------------------------------
// Feature: AI EVALUATOR — grade a free-text student answer
// Returns { score, maxScore, feedback }.
// ---------------------------------------------------------------
async function evaluateAnswer(question, referenceContext, studentAnswer, maxScore = 10) {
  try {
    const raw = await callLLM(
      `You are a strict but fair grader. Grade the student's answer against the reference material on a scale of 0 to ${maxScore}. Return ONLY valid JSON: {"score": <int>, "feedback": "<2-4 sentences: what was correct, what was missing or wrong, and how to improve>"}. No markdown.`,
      `Reference material:\n${referenceContext}\n\nQuestion: ${question}\n\nStudent's answer: ${studentAnswer}`
    );
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    let score = parseInt(parsed.score, 10);
    if (Number.isNaN(score)) score = 0;
    score = Math.max(0, Math.min(maxScore, score));
    return { score, maxScore, feedback: parsed.feedback || 'No feedback returned.' };
  } catch {
    // Fallback: keyword-overlap grading against the reference context.
    const refWords = tokenize(referenceContext);
    const ansWords = tokenize(studentAnswer);
    const refSet = new Set(refWords);
    const ansSet = new Set(ansWords);
    const matched = [...ansSet].filter((w) => refSet.has(w)).length;
    const coverage = refSet.size ? matched / refSet.size : 0;
    const score = Math.max(0, Math.min(maxScore, Math.round(coverage * maxScore * 3)));
    let feedback;
    if (score >= maxScore * 0.8)
      feedback = 'Strong answer — covers most of the key points from the source material.';
    else if (score >= maxScore * 0.5)
      feedback = 'Partially correct — several relevant points present, but some key ideas are missing.';
    else
      feedback = 'Answer misses most of the key concepts in the source material. Review the notes and address the main ideas.';
    return {
      score,
      maxScore,
      feedback: `[Keyword-overlap grading — configure LLM_PROVIDER for semantic AI grading] ${feedback}`,
    };
  }
}

// ---------------------------------------------------------------
// Feature: one study question for a passage (used by the retrieval self-test).
// No fallback: without a real provider there is no way to write a genuine question,
// so this throws NO_PROVIDER and the caller reports that.
// ---------------------------------------------------------------
// kind 'detail' asks about one specific point inside the passage rather than its overall subject.
// Those are the questions where matching word by word should matter most, because a single
// summary vector of the passage is dominated by its main topic.
async function questionForPassage(passage, kind = 'general') {
  const general =
    'You write study questions. Given a passage from a student\'s notes, write ONE question a student might ask ' +
    'that this passage answers. Use your own words: do not copy distinctive phrases from the passage, and do ' +
    'not mention "the passage" or "the text". Return only the question, on one line.';
  const detail =
    'You write study questions. Given a passage from a student\'s notes, write ONE question whose answer is a ' +
    'specific detail stated in the passage: a particular condition, exception, named item, example, value or ' +
    'step. Do NOT ask about the main topic of the passage or ask for a general definition or overview. The ' +
    'question must name the specific thing it asks about, so that it could be answered without seeing the ' +
    'passage, and must be answerable from this passage alone. Do not copy whole phrases from the passage, and ' +
    'do not mention "the passage" or "the text". Return only the question, on one line.';
  const raw = await callLLM(kind === 'detail' ? detail : general, `Passage:\n${passage}`);
  const line = (raw || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return line.replace(/^["'`]+|["'`]+$/g, '').replace(/^(question|q)\s*[:.-]\s*/i, '').trim();
}

// ---- small text helpers used by fallbacks ----
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}
function overlap(setA, arrB) {
  return arrB.filter((w) => setA.has(w)).length;
}

module.exports = {
  summarizeText,
  answerQuestion,
  generateQuiz,
  evaluateAnswer,
  questionForPassage,
  hasRealProvider,
};
