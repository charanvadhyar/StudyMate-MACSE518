/**
 * Requires a valid access token (Authorization: Bearer <jwt>) whose session still exists.
 * Sets req.userId and req.sessionId. A 401 with code TOKEN_EXPIRED tells the frontend to call
 * /api/auth/refresh and retry; any other 401 means signing in again.
 */
const auth = require('../services/authService');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.', code: 'NO_TOKEN' });

  let claims;
  try {
    claims = auth.verifyAccess(token);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'Session expired.' : 'Not signed in.', code: expired ? 'TOKEN_EXPIRED' : 'BAD_TOKEN' });
  }
  try {
    if (!(await auth.sessionIsActive(claims.sessionId, claims.userId))) {
      return res.status(401).json({ error: 'This session was signed out.', code: 'SESSION_ENDED' });
    }
  } catch (err) {
    console.error('[auth] session check failed:', err.message);
    return res.status(503).json({ error: 'Could not check the session. Try again.' });
  }
  req.userId = claims.userId;
  req.sessionId = claims.sessionId;
  return next();
}

module.exports = { authenticate };
