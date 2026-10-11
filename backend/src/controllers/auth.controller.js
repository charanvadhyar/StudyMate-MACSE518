/**
 * Accounts and sessions.
 *
 *   POST /api/auth/register             { name, email, password, inviteCode? } -> sends a verification email
 *   POST /api/auth/verify-email         { token }
 *   POST /api/auth/resend-verification  { email }
 *   POST /api/auth/login                { email, password } -> { accessToken, user } + refresh cookie
 *   POST /api/auth/refresh              (cookie) -> { accessToken, user } + new refresh cookie
 *   POST /api/auth/logout               (cookie) ends this session
 *   POST /api/auth/logout-all           (signed in) ends every session of the user
 *   POST /api/auth/forgot-password      { email } -> sends a reset link (same answer whether or not the email exists)
 *   POST /api/auth/reset-password       { token, password } -> new password, every session ended
 *   GET  /api/auth/me | /sessions | /config
 */
const bcrypt = require('bcryptjs');
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const auth = require('../services/authService');
const email = require('../services/emailService');

const COOKIE = 'sm_refresh';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const INVITE_CODE = process.env.REGISTRATION_INVITE_CODE || '';
const REQUIRE_VERIFICATION = (process.env.REQUIRE_EMAIL_VERIFICATION || 'true') !== 'false';
const SECURE_COOKIE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
// a real hash of a random string, compared when the email is unknown so both cases take as long
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), 12);

const cookieOptions = () => ({
  httpOnly: true,
  secure: SECURE_COOKIE,
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: auth.SESSION_TTL_S * 1000,
});

function setRefreshCookie(res, value) {
  res.cookie(COOKIE, value, cookieOptions());
}
function clearRefreshCookie(res) {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE, opts);
}

const publicUser = (row) => ({ userId: row.user_id.toString(), name: row.name, email: row.email, isAdmin: auth.isAdminEmail(row.email) });

async function userByEmail(addr) {
  const r = await client.execute(
    'SELECT email, user_id, name, password_hash, email_verified, disabled FROM users_by_email WHERE email = ?',
    [addr],
    { prepare: true }
  );
  return r.first();
}

async function userById(id) {
  const r = await client.execute('SELECT user_id, name, email, email_verified, disabled FROM users WHERE user_id = ?', [types.Uuid.fromString(id)], { prepare: true });
  return r.first();
}

async function sendVerificationFor(userId, name, addr) {
  const token = await auth.issueToken('verify', userId, addr);
  await email.sendVerification(addr, name, `${APP_URL}/verify-email?token=${encodeURIComponent(token)}`);
}

// ---------------------------------------------------------------- register
async function register(req, res) {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const addr = auth.normaliseEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const invite = String(req.body?.inviteCode || '').trim();

    if (INVITE_CODE && invite !== INVITE_CODE) {
      return res.status(403).json({ error: 'A valid invite code is needed to create an account.', code: 'INVITE_REQUIRED' });
    }
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!auth.validEmail(addr)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const problem = auth.passwordProblem(password, addr, name);
    if (problem) return res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' });

    const userId = types.Uuid.random();
    const hash = await bcrypt.hash(password, 12);
    const createdAt = new Date();
    const verified = !REQUIRE_VERIFICATION;

    // the lookup table claims the email first; IF NOT EXISTS makes two sign-ups for one address impossible
    const claim = await client.execute(
      'INSERT INTO users_by_email (email, user_id, name, password_hash, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS',
      [addr, userId, name, hash, createdAt, verified],
      { prepare: true }
    );
    if (!claim.wasApplied()) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in or resetting the password.' });
    }
    await client.execute(
      'INSERT INTO users (user_id, name, email, password_hash, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, name, addr, hash, createdAt, verified],
      { prepare: true }
    );

    if (!verified) {
      await sendVerificationFor(userId, name, addr);
      return res.status(201).json({ verificationRequired: true, email: addr, emailDelivered: email.enabled });
    }
    const session = await auth.createSession(userId, req.get('user-agent'));
    setRefreshCookie(res, session.cookieValue);
    return res.status(201).json({
      accessToken: auth.signAccess(userId, session.sessionId),
      expiresIn: auth.ACCESS_TTL_S,
      user: { userId: userId.toString(), name, email: addr, isAdmin: auth.isAdminEmail(addr) },
    });
  } catch (err) {
    console.error('[register]', err);
    return res.status(err.status || 500).json({ error: err.message === 'EMAIL_SEND_FAILED' ? 'The account was created but the email could not be sent. Use "resend" on the sign-in page.' : 'Could not create the account.' });
  }
}

// ---------------------------------------------------------------- email verification
async function verifyEmail(req, res) {
  try {
    const found = await auth.consumeToken('verify', req.body?.token);
    if (!found) return res.status(400).json({ error: 'This link is invalid, already used or expired. Ask for a new one from the sign-in page.' });
    const uid = types.Uuid.fromString(found.userId);
    await client.batch(
      [
        { query: 'UPDATE users SET email_verified = true WHERE user_id = ?', params: [uid] },
        { query: 'UPDATE users_by_email SET email_verified = true WHERE email = ?', params: [found.email] },
      ],
      { prepare: true, logged: true }
    );
    return res.json({ verified: true, email: found.email });
  } catch (err) {
    console.error('[verifyEmail]', err);
    return res.status(500).json({ error: 'Could not verify the email.' });
  }
}

async function resendVerification(req, res) {
  const addr = auth.normaliseEmail(req.body?.email);
  try {
    const row = auth.validEmail(addr) ? await userByEmail(addr) : null;
    if (row && row.email_verified === false) await sendVerificationFor(row.user_id, row.name, addr);
  } catch (err) {
    console.error('[resendVerification]', err.message);
  }
  // same answer either way, so this cannot be used to find out which emails have accounts
  return res.json({ ok: true, message: 'If that account is waiting for confirmation, a new link is on its way.' });
}

// ---------------------------------------------------------------- login / refresh / logout
async function login(req, res) {
  try {
    const raw = String(req.body?.email || '').trim();
    const addr = auth.normaliseEmail(raw);
    const password = String(req.body?.password || '');
    if (!addr || !password) return res.status(400).json({ error: 'Enter your email and password.' });

    if ((await auth.recentFailures(addr)) >= auth.MAX_FAILURES) {
      return res.status(429).json({ error: 'Too many failed attempts for this account. Try again in 15 minutes or reset the password.', code: 'LOCKED' });
    }

    // accounts made before emails were lower-cased are found under the address as typed
    let row = await userByEmail(addr);
    if (!row && raw !== addr) row = await userByEmail(raw);
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) {
      await auth.recordFailure(addr, req.ip);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    if (row.disabled === true) {
      return res.status(403).json({ error: 'This account has been disabled. Contact the administrator.', code: 'DISABLED' });
    }
    if (row.email_verified === false) {
      return res.status(403).json({ error: 'Confirm your email first: open the link we sent you.', code: 'EMAIL_NOT_VERIFIED', email: row.email });
    }

    await auth.clearFailures(addr);
    const session = await auth.createSession(row.user_id, req.get('user-agent'));
    setRefreshCookie(res, session.cookieValue);
    return res.json({ accessToken: auth.signAccess(row.user_id, session.sessionId), expiresIn: auth.ACCESS_TTL_S, user: publicUser(row) });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: 'Could not sign in.' });
  }
}

async function refresh(req, res) {
  try {
    const rotated = await auth.rotateSession(req.cookies?.[COOKIE]);
    if (!rotated) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const user = await userById(rotated.userId);
    if (!user || user.disabled === true) {
      await auth.endSession(rotated.sessionId, rotated.userId);
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Not signed in.' });
    }
    setRefreshCookie(res, rotated.cookieValue);
    return res.json({
      accessToken: auth.signAccess(rotated.userId, rotated.sessionId),
      expiresIn: auth.ACCESS_TTL_S,
      user: { userId: rotated.userId, name: user.name, email: user.email, isAdmin: auth.isAdminEmail(user.email) },
    });
  } catch (err) {
    console.error('[refresh]', err);
    return res.status(500).json({ error: 'Could not refresh the session.' });
  }
}

async function logout(req, res) {
  try {
    const parsed = auth.parseCookie(req.cookies?.[COOKIE]);
    if (parsed) {
      const r = await client.execute('SELECT user_id FROM sessions WHERE session_id = ?', [types.Uuid.fromString(parsed.sessionId)], { prepare: true });
      const row = r.first();
      await auth.endSession(parsed.sessionId, row ? row.user_id.toString() : null);
    }
  } catch (err) {
    console.error('[logout]', err.message);
  }
  clearRefreshCookie(res);
  return res.json({ ok: true });
}

async function logoutAll(req, res) {
  try {
    const n = await auth.endAllSessions(req.userId);
    clearRefreshCookie(res);
    return res.json({ ok: true, sessionsEnded: n });
  } catch (err) {
    console.error('[logoutAll]', err);
    return res.status(500).json({ error: 'Could not sign out everywhere.' });
  }
}

// ---------------------------------------------------------------- password reset
async function forgotPassword(req, res) {
  const addr = auth.normaliseEmail(req.body?.email);
  try {
    const row = auth.validEmail(addr) ? await userByEmail(addr) : null;
    if (row) {
      const token = await auth.issueToken('reset', row.user_id, addr);
      await email.sendPasswordReset(addr, row.name, `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`);
    }
  } catch (err) {
    console.error('[forgotPassword]', err.message);
  }
  return res.json({ ok: true, message: 'If an account uses that email, a reset link is on its way. It works for one hour.' });
}

async function resetPassword(req, res) {
  try {
    const token = req.body?.token;
    const password = String(req.body?.password || '');
    const pending = await auth.readToken('reset', token);
    if (!pending) return res.status(400).json({ error: 'This link is invalid, already used or expired. Ask for a new one.' });
    const user = await userById(pending.userId);
    const problem = auth.passwordProblem(password, pending.email, user?.name);
    if (problem) return res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' });

    const found = await auth.consumeToken('reset', token);
    if (!found) return res.status(400).json({ error: 'This link was already used.' });
    const hash = await bcrypt.hash(password, 12);
    const uid = types.Uuid.fromString(found.userId);
    // the link proves the address works, so the account counts as verified too
    await client.batch(
      [
        { query: 'UPDATE users SET password_hash = ?, email_verified = true WHERE user_id = ?', params: [hash, uid] },
        { query: 'UPDATE users_by_email SET password_hash = ?, email_verified = true WHERE email = ?', params: [hash, found.email] },
      ],
      { prepare: true, logged: true }
    );
    await auth.endAllSessions(found.userId);
    await auth.clearFailures(found.email);
    clearRefreshCookie(res);
    return res.json({ ok: true, message: 'Password changed. Sign in with the new one; every other session was signed out.' });
  } catch (err) {
    console.error('[resetPassword]', err);
    return res.status(500).json({ error: 'Could not reset the password.' });
  }
}

// ---------------------------------------------------------------- info
async function me(req, res) {
  const user = await userById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  return res.json({ userId: req.userId, name: user.name, email: user.email, isAdmin: auth.isAdminEmail(user.email) });
}

async function sessions(req, res) {
  const list = await auth.listSessions(req.userId);
  return res.json({ items: list.map((s) => ({ ...s, current: s.sessionId === req.sessionId })) });
}

function config(req, res) {
  return res.json({ inviteRequired: Boolean(INVITE_CODE), emailVerification: REQUIRE_VERIFICATION, emailDelivery: email.enabled });
}

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
  me,
  sessions,
  config,
};
