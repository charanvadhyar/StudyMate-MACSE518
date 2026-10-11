/**
 * chat.controller.js — chat sessions + messages + document-grounded Q&A.
 * A user message triggers retrieval of the relevant chunks of the linked document
 * (services/retrievalService.js), which are passed as context to the AI answer service; both the user message and
 * the bot reply are persisted (atomic batch write to the messages table).
 */
const { v4: uuidv4 } = require('uuid');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const llm = require('../services/llmService');
const analytics = require('../services/analyticsWrites');
const retrieval = require('../services/retrievalService');

// CREATE session
async function createSession(req, res) {
  try {
    const { documentId, title } = req.body;
    const sessionId = uuidv4();
    const startedAt = new Date();
    await client.execute(
      'INSERT INTO chat_sessions (user_id, started_at, session_id, document_id, title) VALUES (?, ?, ?, ?, ?)',
      [req.userId, startedAt, sessionId,
       documentId ? types.Uuid.fromString(documentId) : null, title || 'New session'],
      { prepare: true }
    );
    return res.status(201).json({ sessionId, startedAt, title: title || 'New session' });
  } catch (err) {
    console.error('[createSession]', err);
    return res.status(500).json({ error: 'Failed to create session' });
  }
}

// READ sessions (list), newest first
async function listSessions(req, res) {
  try {
    const result = await client.execute(
      'SELECT started_at, session_id, document_id, title FROM chat_sessions WHERE user_id = ?',
      [req.userId],
      { prepare: true }
    );
    return res.json(result.rows.map((r) => ({
      startedAt: r.started_at,
      sessionId: r.session_id.toString(),
      documentId: r.document_id ? r.document_id.toString() : null,
      title: r.title,
    })));
  } catch (err) {
    console.error('[listSessions]', err);
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
}

// READ messages for a session, chronological
async function getMessages(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await client.execute(
      'SELECT sent_at, sender, message_text FROM messages WHERE session_id = ?',
      [sessionId],
      { prepare: true }
    );
    return res.json(result.rows.map((r) => ({
      sentAt: r.sent_at,
      sender: r.sender,
      text: r.message_text,
    })));
  } catch (err) {
    console.error('[getMessages]', err);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
}

// SEND message — store user msg, generate grounded answer, store bot msg
async function sendMessage(req, res) {
  try {
    const { sessionId } = req.params;
    const { text, documentId } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    // earlier turns of this session (oldest first), so follow-ups like "explain more" make sense
    const past = await client.execute(
      'SELECT sender, message_text FROM messages WHERE session_id = ?',
      [sessionId],
      { prepare: true }
    );
    const history = past.rows.slice(-6).map((r) => ({ sender: r.sender, text: (r.message_text || '').slice(0, 1200) }));

    // A follow-up ("elaborate", "why?", "give an example") says nothing about its topic by itself.
    // Search with the previous question as well, so retrieval stays on the subject being discussed.
    const previousQuestion = [...history].reverse().find((m) => m.sender === 'user')?.text || '';
    const isFollowUp =
      previousQuestion &&
      (text.trim().split(/\s+/).length <= 6 ||
        /^(please\s+|can you\s+|could you\s+)?(elaborate|expand|more\b|go on|continue|tell me more|and\b|what about|how so|why is that|(explain|simplify|summari[sz]e|repeat)\s+(that|it|this|more|further|again)|give\s+(me\s+)?(an?\s+)?(example|more))/i.test(text.trim()));
    const retrievalQuery = isFollowUp ? `${previousQuestion} ${text}` : text;

    // retrieve context from the linked document: the few chunks relevant to this question
    // when the retrieval index is available, the whole document otherwise
    const { context, mode, sources, chunksUsed } = await retrieval.buildContext(documentId, retrievalQuery);

    const answer = await llm.answerQuestion(text, context, history);

    const now = Date.now();
    await client.batch(
      [
        {
          query: 'INSERT INTO messages (session_id, sent_at, message_id, sender, message_text) VALUES (?, ?, ?, ?, ?)',
          params: [types.Uuid.fromString(sessionId), new Date(now), uuidv4(), 'user', text],
        },
        {
          query: 'INSERT INTO messages (session_id, sent_at, message_id, sender, message_text) VALUES (?, ?, ?, ?, ?)',
          params: [types.Uuid.fromString(sessionId), new Date(now + 1), uuidv4(), 'bot', answer],
        },
      ],
      { prepare: true }
    );

    await analytics.onChatMessage(req.userId);
    return res.json({ answer, retrieval: { mode, chunksUsed, sources, followUp: Boolean(isFollowUp) } });
  } catch (err) {
    console.error('[sendMessage]', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
}

module.exports = { createSession, listSessions, getMessages, sendMessage };
