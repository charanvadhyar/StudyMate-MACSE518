/**
 * In-memory API metrics for the admin panel: requests per route, status classes, latency
 * percentiles, a per-minute series for the last hour, and the most recent server errors.
 * Kept in this process only (reset on restart); enough for one API instance.
 */
const started = Date.now();
const routes = new Map(); // "GET /api/chat/:sessionId" -> { count, errors, durations: [] }
const minutes = new Map(); // minute epoch -> { count, errors, totalMs }
const recentErrors = [];
const MAX_SAMPLES = 500;

const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function routeKey(req) {
  const path = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.originalUrl.split('?')[0].replace(ID, ':id').replace(/\/\d+(?=\/|$)/g, '/:n');
  return `${req.method} ${path}`;
}

function middleware(req, res, next) {
  if (!req.originalUrl.startsWith('/api/')) return next();
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const key = routeKey(req);
    const r = routes.get(key) || { count: 0, errors: 0, clientErrors: 0, durations: [] };
    r.count += 1;
    if (res.statusCode >= 500) r.errors += 1;
    else if (res.statusCode >= 400) r.clientErrors += 1;
    r.durations.push(ms);
    if (r.durations.length > MAX_SAMPLES) r.durations.shift();
    routes.set(key, r);

    const minute = Math.floor(Date.now() / 60000);
    const m = minutes.get(minute) || { count: 0, errors: 0, totalMs: 0 };
    m.count += 1;
    m.totalMs += ms;
    if (res.statusCode >= 500) m.errors += 1;
    minutes.set(minute, m);
    for (const k of minutes.keys()) if (k < minute - 60) minutes.delete(k);

    if (res.statusCode >= 500) {
      recentErrors.unshift({ at: new Date().toISOString(), route: key, status: res.statusCode, ms: Math.round(ms) });
      recentErrors.length = Math.min(recentErrors.length, 50);
    }
  });
  return next();
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
}

function snapshot() {
  const list = [...routes.entries()].map(([route, r]) => {
    const s = [...r.durations].sort((a, b) => a - b);
    return { route, count: r.count, serverErrors: r.errors, clientErrors: r.clientErrors, p50: pct(s, 50), p95: pct(s, 95), max: pct(s, 100) };
  });
  list.sort((a, b) => b.count - a.count);
  const now = Math.floor(Date.now() / 60000);
  const series = [];
  for (let k = now - 59; k <= now; k++) {
    const m = minutes.get(k) || { count: 0, errors: 0, totalMs: 0 };
    series.push({ minute: new Date(k * 60000).toISOString(), requests: m.count, errors: m.errors, avgMs: m.count ? Math.round(m.totalMs / m.count) : 0 });
  }
  const total = list.reduce((n, r) => n + r.count, 0);
  const errors = list.reduce((n, r) => n + r.serverErrors, 0);
  return {
    since: new Date(started).toISOString(),
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    totalRequests: total,
    serverErrors: errors,
    errorRate: total ? errors / total : 0,
    routes: list,
    lastHour: series,
    recentErrors,
  };
}

module.exports = { middleware, snapshot };
