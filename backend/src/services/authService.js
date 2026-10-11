/**
 * Sessions, one-time email tokens, password rules and login throttling.
 *
 * Access: a short-lived JWT (15 min) kept in the browser's memory and sent as a Bearer header.
 * Refresh: "<session_id>.<secret>" in an httpOnly cookie; the server stores only a SHA-256 of
 * the secret in `sessions`. Every refresh swaps the secret with a lightweight transaction, so a
 * secret that was already used is detected (someone copied the cookie) and the session ends.
 * Every API request also checks that its session still exists, so logout takes effect at once.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET === 'change_this_to_a_long_random_string' || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production');
  }
  console.warn('[auth] JWT_SECRET is missing or weak; fine for local development only');
}
const SECRET = JWT_SECRET || 'dev-only-secret-not-for-production-use-000000';

const ACCESS_TTL_S = 15 * 60;
const SESSION_TTL_S = 30 * 24 * 3600;
const VERIFY_TTL_S = 24 * 3600;
const RESET_TTL_S = 3600;
const MAX_FAILURES = 5; // per email in the last 15 minutes (TTL on login_failures)

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomSecret = () => crypto.randomBytes(32).toString('base64url');
const uuid = (s) => types.Uuid.fromString(String(s));

// ---------------------------------------------------------------- passwords
const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou123',
  'welcome123', 'admin12345', 'letmein123', 'studymate1', 'studymate123', 'abc1234567', 'qwerty12345',
]);

/** @returns {string|null} the reason the password is not allowed, or null */
function passwordProblem(password, email = '', name = '') {
  const p = String(password || '');
  if (p.length < 10) return 'Use at least 10 characters.';
  if (p.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Use both letters and numbers.';
  const lower = p.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && lower.includes(local)) return 'Do not use your email address in the password.';
  const first = String(name).toLowerCase().split(/\s+/)[0] || '';
  if (first.length >= 4 && lower.includes(first)) return 'Do not use your name in the password.';
  return null;
}

const normaliseEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

// ---------------------------------------------------------------- access tokens
function signAccess(userId, sessionId) {
  return jwt.sign({ sub: String(userId), sid: String(sessionId) }, SECRET, { expiresIn: ACCESS_TTL_S });
}

function verifyAccess(token) {
  const p = jwt.verify(token, SECRET);
  if (!p.sub || !p.sid) throw new Error('old token format');
  return { userId: p.sub, sessionId: p.sid };
}

// a short cache so each API call does not read `sessions`; logout clears the entry
const alive = new Map(); // sessionId -> expiry ms
const ALIVE_MS = 30 * 1000;

async function sessionIsActive(sessionId, userId) {
  const hit = alive.get(sessionId);
  if (hit && hit > Date.now()) return true;
  const r = await client.execute('SELECT user_id FROM sessions WHERE session_id = ?', [uuid(sessionId)], { prepare: true });
  const row = r.first();
  const ok = Boolean(row && row.user_id.toString() === String(userId));
  if (ok) alive.set(sessionId, Date.now() + ALIVE_MS);
  else alive.delete(sessionId);
  return ok;
}

// ---------------------------------------------------------------- sessions
async function createSession(userId, userAgent = '') {
  const sessionId = types.Uuid.random();
  const secret = randomSecret();
  const now = new Date();
  const ua = String(userAgent || '').slice(0, 200);
  await client.batch(
    [
      {
        query: 'INSERT INTO sessions (session_id, user_id, refresh_hash, created_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?) USING TTL ?',
        params: [sessionId, uuid(userId), sha256(secret), now, now, ua, SESSION_TTL_S],
      },
      {
        query: 'INSERT INTO sessions_by_user (user_id, session_id, created_at, user_agent) VALUES (?, ?, ?, ?) USING TTL ?',
        params: [uuid(userId), sessionId, now, ua, SESSION_TTL_S],
      },
    ],
    { prepare: true, logged: true }
  );
  return { sessionId: sessionId.toString(), cookieValue: `${sessionId}.${secret}` };
}

function parseCookie(value) {
  const [sid, secret] = String(value || '').split('.');
  if (!sid || !secret || !/^[0-9a-f-]{36}$/i.test(sid)) return null;
  return { sessionId: sid, secret };
}

/**
 * Swap the refresh secret. Returns { userId, sessionId, cookieValue } or null when the cookie
 * is unknown, expired, or was already used (in which case the session is ended).
 */
async function rotateSession(cookieValue) {
  const parsed = parseCookie(cookieValue);
  if (!parsed) return null;
  const r = await client.execute(
    'SELECT user_id, refresh_hash, created_at, user_agent FROM sessions WHERE session_id = ?',
    [uuid(parsed.sessionId)],
    { prepare: true }
  );
  const row = r.first();
  if (!row) return null;
  const userId = row.user_id.toString();
  const presented = sha256(parsed.secret);
  if (presented !== row.refresh_hash) {
    // an old secret came back: the cookie was copied, or two tabs raced; end the session
    console.warn(`[auth] refresh secret reused for session ${parsed.sessionId}; ending it`);
    await endSession(parsed.sessionId, userId);
    return null;
  }
  const secret = randomSecret();
  const upd = await client.execute(
    'UPDATE sessions USING TTL ? SET refresh_hash = ?, last_used_at = ?, user_id = ?, created_at = ?, user_agent = ? WHERE session_id = ? IF refresh_hash = ?',
    [SESSION_TTL_S, sha256(secret), new Date(), row.user_id, row.created_at, row.user_agent, uuid(parsed.sessionId), presented],
    { prepare: true }
  );
  if (!upd.wasApplied()) return null; // another refresh won the race; that one holds the new cookie
  return { userId, sessionId: parsed.sessionId, cookieValue: `${parsed.sessionId}.${secret}` };
}

async function endSession(sessionId, userId) {
  alive.delete(String(sessionId));
  const q = [{ query: 'DELETE FROM sessions WHERE session_id = ?', params: [uuid(sessionId)] }];
  if (userId) q.push({ query: 'DELETE FROM sessions_by_user WHERE user_id = ? AND session_id = ?', params: [uuid(userId), uuid(sessionId)] });
  await client.batch(q, { prepare: true, logged: true });
}

async function endAllSessions(userId) {
  const r = await client.execute('SELECT session_id FROM sessions_by_user WHERE user_id = ?', [uuid(userId)], { prepare: true });
  for (const row of r.rows) {
    alive.delete(row.session_id.toString());
    await client.execute('DELETE FROM sessions WHERE session_id = ?', [row.session_id], { prepare: true });
  }
  await client.execute('DELETE FROM sessions_by_user WHERE user_id = ?', [uuid(userId)], { prepare: true });
  return r.rows.length;
}

async function listSessions(userId) {
  const r = await client.execute('SELECT session_id, created_at, user_agent FROM sessions_by_user WHERE user_id = ?', [uuid(userId)], { prepare: true });
  return r.rows.map((x) => ({ sessionId: x.session_id.toString(), createdAt: x.created_at, userAgent: x.user_agent }));
}

// ---------------------------------------------------------------- one-time email tokens
async function issueToken(purpose, userId, email) {
  const token = randomSecret();
  const ttl = purpose === 'reset' ? RESET_TTL_S : VERIFY_TTL_S;
  await client.execute(
    'INSERT INTO auth_tokens (token_hash, purpose, user_id, email, created_at) VALUES (?, ?, ?, ?, ?) USING TTL ?',
    [sha256(token), purpose, uuid(userId), email, new Date(), ttl],
    { prepare: true }
  );
  return token;
}

/** Use a token once. Returns { userId, email } or null. */
async function consumeToken(purpose, token) {
  const found = await readToken(purpose, token);
  if (!found) return null;
  // delete-if-exists is a lightweight transaction: two clicks on one link cannot both succeed
  const r = await client.execute('DELETE FROM auth_tokens WHERE token_hash = ? IF EXISTS', [sha256(String(token))], { prepare: true });
  return r.wasApplied() ? found : null;
}

async function readToken(purpose, token) {
  if (!token || String(token).length > 100) return null;
  const r = await client.execute('SELECT purpose, user_id, email FROM auth_tokens WHERE token_hash = ?', [sha256(String(token))], { prepare: true });
  const row = r.first();
  if (!row || row.purpose !== purpose) return null;
  return { userId: row.user_id.toString(), email: row.email };
}

// ---------------------------------------------------------------- login throttling
async function recentFailures(email) {
  const r = await client.execute('SELECT COUNT(*) AS n FROM login_failures WHERE email = ?', [email], { prepare: true });
  const n = r.first().n; // a driver Long
  return typeof n?.toNumber === 'function' ? n.toNumber() : Number(n);
}

async function recordFailure(email, ip) {
  await client.execute('INSERT INTO login_failures (email, failed_at, ip) VALUES (?, now(), ?)', [email, String(ip || '')], { prepare: true });
}

async function clearFailures(email) {
  await client.execute('DELETE FROM login_failures WHERE email = ?', [email], { prepare: true });
}

// ---------------------------------------------------------------- admins
/** Admins are the accounts whose email is in ADMIN_EMAILS (comma-separated). */
function adminEmails() {
  return new Set((process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}
const isAdminEmail = (email) => adminEmails().has(String(email || '').toLowerCase());

module.exports = {
  adminEmails,
  isAdminEmail,
  ACCESS_TTL_S,
  SESSION_TTL_S,
  MAX_FAILURES,
  passwordProblem,
  normaliseEmail,
  validEmail,
  signAccess,
  verifyAccess,
  sessionIsActive,
  createSession,
  rotateSession,
  endSession,
  endAllSessions,
  listSessions,
  parseCookie,
  issueToken,
  readToken,
  consumeToken,
  recentFailures,
  recordFailure,
  clearFailures,
};
