/**
 * server.js — StudyMate backend entry point.
 * Wires up middleware, routes, a health check, and connects to Cassandra
 * before listening.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const { connect, client, consistencyName } = require('./config/cassandra');
const { hasRealProvider } = require('./services/llmService');
const retrieval = require('./services/retrievalService');

const authRoutes = require('./routes/auth.routes');
const documentRoutes = require('./routes/documents.routes');
const chatRoutes = require('./routes/chat.routes');
const quizRoutes = require('./routes/quiz.routes');
const evaluationRoutes = require('./routes/evaluation.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const adminRoutes = require('./routes/admin.routes');
const metrics = require('./services/metrics');

const app = express();
// Behind Railway's proxy (and Vercel's, for /api/auth) the client address is in
// X-Forwarded-For; this says how many proxies to trust so rate limits see the real client.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1', 10));

// Browsers may call the API only from these origins. Credentials are allowed so the refresh
// cookie works in local development (frontend on :3000, API on :4000).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
    credentials: true,
  })
);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(metrics.middleware);
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));

// health check
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    aiProvider: hasRealProvider ? 'configured' : 'fallback-mode',
    cassandra: {
      nodes: client.hosts.values().map((h) => ({ address: h.address, datacenter: h.datacenter, up: h.isUp() })),
      consistency: consistencyName,
    },
    retrieval: await retrieval.health(),
  });
});

// feature routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);

// unknown API paths stay JSON 404s
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Hosting: when the frontend has been built (npm run build in studymate-frontend), serve it from
// here too, so one address (and one tunnel) carries both the app and the API.
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.resolve(__dirname, '../../studymate-frontend/build');
const hasFrontend = fs.existsSync(path.join(FRONTEND_DIR, 'index.html'));
if (hasFrontend) {
  app.use(express.static(FRONTEND_DIR));
  // client-side routes (/chat, /quiz, ...) all load the app
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
}

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 4000;

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] StudyMate API listening on http://localhost:${PORT}`);
      console.log(`[server] Frontend: ${hasFrontend ? `served from ${FRONTEND_DIR}` : 'not built (run npm run build in studymate-frontend to serve it here)'}`);
      console.log(`[server] Retrieval: ${retrieval.enabled ? 'sidecar enabled' : 'off (whole-document context; set RETRIEVAL_ENABLED=true)'}`);
      console.log(`[server] AI grading: ${hasRealProvider ? 'live LLM' : 'fallback (set LLM_PROVIDER to enable)'}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to connect to Cassandra:', err.message);
    process.exit(1);
  });

module.exports = app;
