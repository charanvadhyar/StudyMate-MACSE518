/**
 * Admin-only routes. Runs after authenticate; the account's email must be in ADMIN_EMAILS.
 * The email is read from Cassandra (cached a minute) rather than trusted from the token.
 */
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const auth = require('../services/authService');

const cache = new Map(); // userId -> { email, until }

async function requireAdmin(req, res, next) {
  try {
    let hit = cache.get(req.userId);
    if (!hit || hit.until < Date.now()) {
      const r = await client.execute('SELECT email FROM users WHERE user_id = ?', [types.Uuid.fromString(req.userId)], { prepare: true });
      hit = { email: r.first()?.email || '', until: Date.now() + 60000 };
      cache.set(req.userId, hit);
    }
    if (!auth.isAdminEmail(hit.email)) return res.status(403).json({ error: 'Admins only.', code: 'NOT_ADMIN' });
    req.adminEmail = hit.email;
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { requireAdmin };
