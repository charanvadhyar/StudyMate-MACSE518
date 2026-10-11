/**
 * Admin panel API (all routes need an admin: an email listed in ADMIN_EMAILS).
 *
 *   GET  /api/admin/overview                     cluster, keyspaces, row counts, services, API summary
 *   GET  /api/admin/nodes                        per-node details from system tables and virtual tables
 *   GET  /api/admin/schema                       keyspaces -> tables -> columns, keys, options, indexes
 *   GET  /api/admin/tables/:ks/:table/rows       paged rows (secrets redacted); ?where={"col":"value"} for one partition
 *   GET  /api/admin/users                        accounts with activity counters and session counts
 *   POST /api/admin/users/:id/(revoke-sessions|disable|enable|verify)
 *   GET  /api/admin/audit                        admin actions, last 7 days
 *   GET  /api/admin/metrics                      API request metrics
 */
const os = require('os');
const { types } = require('cassandra-driver');
const { client, keyspace, consistencyName } = require('../config/cassandra');
const retrieval = require('../services/retrievalService');
const auth = require('../services/authService');
const metrics = require('../services/metrics');
const { hasRealProvider } = require('../services/llmService');

const ONE = { consistency: types.consistencies.localOne };
const BROWSABLE = new Set([keyspace, 'smdb', 'smdb_compare', 'smdb_compare_idx']);
const SECRET_COL = /(password|hash|secret|token)/i;

const safe = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch (err) {
    return fallback === null ? { error: err.message } : fallback;
  }
};

async function audit(req, action, target, detail = '') {
  const day = new Date().toISOString().slice(0, 10);
  await safe(() =>
    client.execute(
      'INSERT INTO admin_audit (day, at, admin_email, action, target, detail) VALUES (?, now(), ?, ?, ?, ?)',
      [day, req.adminEmail || '', action, String(target || ''), String(detail || '')],
      { prepare: true }
    )
  );
}

function hostList() {
  return client.hosts.values().map((h) => ({
    address: h.address,
    datacenter: h.datacenter,
    rack: h.rack,
    up: h.isUp(),
    version: h.cassandraVersion,
    hostId: h.hostId ? h.hostId.toString() : null,
  }));
}

async function countRows(table, ks = keyspace) {
  // COUNT(*) reads every partition; fine for an app of this size, and bounded by a timeout
  const r = await client.execute(`SELECT COUNT(*) AS n FROM ${ks}.${table}`, [], { ...ONE, readTimeout: 15000 });
  return Number(r.first().n);
}

// ---------------------------------------------------------------- overview
async function overview(req, res) {
  const [keyspaces, counts, retrievalHealth] = await Promise.all([
    safe(async () => {
      const r = await client.execute('SELECT keyspace_name, replication, durable_writes FROM system_schema.keyspaces', [], ONE);
      return r.rows
        .filter((k) => !k.keyspace_name.startsWith('system'))
        .map((k) => ({ name: k.keyspace_name, replication: k.replication, durableWrites: k.durable_writes }));
    }, []),
    (async () => {
      const out = {};
      for (const t of ['users', 'documents', 'document_chunks', 'chat_sessions', 'messages', 'quizzes', 'quiz_attempts', 'evaluations', 'sessions']) {
        out[t] = await safe(() => countRows(t), null);
      }
      return out;
    })(),
    retrieval.health(),
  ]);
  const m = metrics.snapshot();
  return res.json({
    cluster: {
      name: client.metadata.clusterName || null,
      consistency: consistencyName,
      nodes: hostList(),
    },
    keyspaces,
    counts,
    services: {
      api: {
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        hostMemoryFreeMb: Math.round(os.freemem() / 1048576),
      },
      retrieval: retrievalHealth,
      llm: { configured: hasRealProvider, provider: process.env.LLM_PROVIDER || 'none', model: process.env.LLM_MODEL || null },
      email: { configured: Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM) },
    },
    indexing: retrieval.activeIndexing(),
    api: { totalRequests: m.totalRequests, serverErrors: m.serverErrors, errorRate: m.errorRate, uptimeSeconds: m.uptimeSeconds },
  });
}

// ---------------------------------------------------------------- per node
async function onHost(host, query) {
  return client.execute(query, [], { ...ONE, host, readTimeout: 8000 });
}

async function nodes(req, res) {
  const hosts = client.hosts.values();
  const out = await Promise.all(
    hosts.map(async (host) => {
      const base = { address: host.address, datacenter: host.datacenter, rack: host.rack, up: host.isUp() };
      if (!host.isUp()) return base;
      const local = await safe(async () => {
        const r = await onHost(host, 'SELECT release_version, cluster_name, data_center, rack, host_id, tokens, schema_version, bootstrapped FROM system.local');
        const x = r.first();
        return { version: x.release_version, hostId: String(x.host_id), tokens: (x.tokens || []).length, schemaVersion: String(x.schema_version), bootstrapped: x.bootstrapped };
      });
      const threadPools = await safe(async () => {
        const r = await onHost(host, 'SELECT name, active_tasks, pending_tasks, blocked_tasks, completed_tasks FROM system_views.thread_pools');
        return r.rows
          .map((p) => ({ name: p.name, active: Number(p.active_tasks), pending: Number(p.pending_tasks), blocked: Number(p.blocked_tasks), completed: Number(p.completed_tasks) }))
          .filter((p) => p.completed > 0 || p.pending > 0 || p.active > 0)
          .sort((a, b) => b.completed - a.completed)
          .slice(0, 12);
      }, []);
      const caches = await safe(async () => {
        const r = await onHost(host, 'SELECT name, entry_count, hit_ratio, size_bytes, capacity_bytes FROM system_views.caches');
        return r.rows.map((c) => ({ name: c.name, entries: Number(c.entry_count), hitRatio: Number(c.hit_ratio), sizeBytes: Number(c.size_bytes), capacityBytes: Number(c.capacity_bytes) }));
      }, []);
      const clients = await safe(async () => {
        const r = await onHost(host, 'SELECT address, driver_name, request_count FROM system_views.clients');
        return { connections: r.rows.length, drivers: [...new Set(r.rows.map((c) => c.driver_name).filter(Boolean))] };
      }, { connections: null, drivers: [] });
      const disk = await safe(async () => {
        const r = await onHost(host, 'SELECT keyspace_name, table_name, mebibytes FROM system_views.disk_usage');
        const byKs = {};
        for (const row of r.rows) {
          if (row.keyspace_name.startsWith('system')) continue;
          byKs[row.keyspace_name] = (byKs[row.keyspace_name] || 0) + Number(row.mebibytes);
        }
        return byKs;
      }, {});
      const latency = await safe(async () => {
        const read = await onHost(host, 'SELECT keyspace_name, table_name, count, p50th_ms, p99th_ms FROM system_views.local_read_latency');
        const write = await onHost(host, 'SELECT keyspace_name, table_name, count, p50th_ms, p99th_ms FROM system_views.local_write_latency');
        const pick = (rows) =>
          rows
            .filter((r) => BROWSABLE.has(r.keyspace_name) && Number(r.count) > 0)
            .map((r) => ({ table: `${r.keyspace_name}.${r.table_name}`, count: Number(r.count), p50: Number(r.p50th_ms), p99: Number(r.p99th_ms) }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        return { reads: pick(read.rows), writes: pick(write.rows) };
      }, { reads: [], writes: [] });
      return { ...base, ...local, threadPools, caches, clients, diskMiB: disk, latency };
    })
  );
  return res.json({ nodes: out, consistency: consistencyName });
}

// ---------------------------------------------------------------- schema
async function schema(req, res) {
  try {
    const [tables, columns, indexes] = await Promise.all([
      client.execute('SELECT keyspace_name, table_name, default_time_to_live, compaction, comment, gc_grace_seconds FROM system_schema.tables', [], ONE),
      client.execute('SELECT keyspace_name, table_name, column_name, type, kind, position, clustering_order FROM system_schema.columns', [], ONE),
      client.execute('SELECT keyspace_name, table_name, index_name, kind, options FROM system_schema.indexes', [], ONE),
    ]);
    const ks = {};
    for (const t of tables.rows) {
      if (!BROWSABLE.has(t.keyspace_name)) continue;
      ks[t.keyspace_name] = ks[t.keyspace_name] || {};
      ks[t.keyspace_name][t.table_name] = {
        name: t.table_name,
        defaultTtl: t.default_time_to_live,
        compaction: (t.compaction?.class || '').split('.').pop(),
        gcGraceSeconds: t.gc_grace_seconds,
        columns: [],
        indexes: [],
      };
    }
    const rank = { partition_key: 0, clustering: 1, static: 2, regular: 3 };
    for (const c of columns.rows) {
      const t = ks[c.keyspace_name]?.[c.table_name];
      if (!t) continue;
      t.columns.push({ name: c.column_name, type: c.type, kind: c.kind, position: c.position, order: c.clustering_order });
    }
    for (const i of indexes.rows) {
      const t = ks[i.keyspace_name]?.[i.table_name];
      if (t) t.indexes.push({ name: i.index_name, kind: i.kind, target: i.options?.target, class: (i.options?.class_name || '').split('.').pop() });
    }
    const out = Object.entries(ks).map(([name, tbls]) => ({
      name,
      tables: Object.values(tbls)
        .map((t) => {
          t.columns.sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.name.localeCompare(b.name));
          t.partitionKey = t.columns.filter((c) => c.kind === 'partition_key').map((c) => c.name);
          t.clusteringKey = t.columns.filter((c) => c.kind === 'clustering').map((c) => `${c.name} ${c.order === 'desc' ? 'DESC' : 'ASC'}`);
          t.counter = t.columns.some((c) => c.type === 'counter');
          return t;
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    out.sort((a, b) => (a.name === keyspace ? -1 : b.name === keyspace ? 1 : a.name.localeCompare(b.name)));
    return res.json({ keyspaces: out });
  } catch (err) {
    console.error('[admin.schema]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------- row browser
function display(value, colName) {
  if (value === null || value === undefined) return null;
  if (SECRET_COL.test(colName)) return '[redacted]';
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (value instanceof types.Uuid || value instanceof types.TimeUuid) return value.toString();
  if (value instanceof types.Long) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length > 8 && typeof value[0] === 'number') return `<vector of ${value.length}>`;
    return value.slice(0, 10).map((v) => display(v, ''));
  }
  if (typeof value === 'object' && value.constructor && value.constructor.name === 'Float32Array') return `<vector of ${value.length}>`;
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}… (${value.length} chars)`;
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  return value;
}

function convert(raw, type) {
  const t = String(type).toLowerCase();
  if (t === 'uuid') return types.Uuid.fromString(raw);
  if (t === 'timeuuid') return types.TimeUuid.fromString(raw);
  if (t === 'int' || t === 'smallint' || t === 'tinyint') return parseInt(raw, 10);
  if (t === 'bigint' || t === 'counter') return types.Long.fromString(String(raw));
  if (t === 'boolean') return raw === true || raw === 'true';
  if (t === 'timestamp') return new Date(raw);
  if (t === 'float' || t === 'double') return Number(raw);
  return String(raw);
}

async function rows(req, res) {
  const { ks, table } = req.params;
  if (!BROWSABLE.has(ks) || !/^[a-z0-9_]+$/i.test(table)) return res.status(400).json({ error: 'Unknown table.' });
  try {
    const cols = await client.execute(
      'SELECT column_name, type, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
      [ks, table],
      { prepare: true, ...ONE }
    );
    if (!cols.rows.length) return res.status(404).json({ error: 'Unknown table.' });
    const rank = { partition_key: 0, clustering: 1, static: 2, regular: 3 };
    const columns = cols.rows
      .map((c) => ({ name: c.column_name, type: c.type, kind: c.kind, position: c.position }))
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.position - b.position || a.name.localeCompare(b.name));
    const pk = columns.filter((c) => c.kind === 'partition_key');

    let where = '';
    const params = [];
    if (req.query.where) {
      let filter;
      try {
        filter = JSON.parse(req.query.where);
      } catch {
        return res.status(400).json({ error: 'where must be JSON.' });
      }
      const missing = pk.filter((c) => filter[c.name] === undefined || filter[c.name] === '');
      if (missing.length) return res.status(400).json({ error: `Give every partition key column: ${pk.map((c) => c.name).join(', ')}.` });
      try {
        pk.forEach((c) => params.push(convert(filter[c.name], c.type)));
      } catch (err) {
        return res.status(400).json({ error: `Bad key value: ${err.message}` });
      }
      where = ` WHERE ${pk.map((c) => `"${c.name}" = ?`).join(' AND ')}`;
    }
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
    const cql = `SELECT * FROM "${ks}"."${table}"${where}`;
    const r = await client.execute(cql, params, {
      prepare: true,
      fetchSize: limit,
      pageState: req.query.pageState || undefined,
      ...ONE,
      readTimeout: 15000,
    });
    return res.json({
      keyspace: ks,
      table,
      cql: where ? `${cql}  -- one partition` : `${cql}  -- full scan, page of ${limit}`,
      columns,
      rows: r.rows.map((row) => Object.fromEntries(columns.map((c) => [c.name, display(row[c.name], c.name)]))),
      nextPageState: r.pageState || null,
    });
  } catch (err) {
    console.error('[admin.rows]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------- users
async function users(req, res) {
  try {
    const r = await client.execute('SELECT user_id, name, email, created_at, email_verified, disabled FROM users', [], { ...ONE, fetchSize: 1000 });
    const admins = auth.adminEmails();
    const list = [];
    for (const u of r.rows) {
      const [stats, sess] = await Promise.all([
        safe(async () => (await client.execute('SELECT * FROM user_stats WHERE user_id = ?', [u.user_id], { prepare: true })).first(), null),
        safe(async () => (await client.execute('SELECT COUNT(*) AS n FROM sessions_by_user WHERE user_id = ?', [u.user_id], { prepare: true })).first(), null),
      ]);
      const n = (v) => (v == null ? 0 : Number(v));
      list.push({
        userId: u.user_id.toString(),
        name: u.name,
        email: u.email,
        createdAt: u.created_at,
        verified: u.email_verified !== false,
        disabled: u.disabled === true,
        admin: admins.has(String(u.email || '').toLowerCase()),
        sessions: sess && !sess.error ? n(sess.n) : null,
        documents: stats && !stats.error ? n(stats.documents_count) : 0,
        quizzes: stats && !stats.error ? n(stats.quizzes_taken) : 0,
        evaluations: stats && !stats.error ? n(stats.evaluations_done) : 0,
        messages: stats && !stats.error ? n(stats.chat_messages_count) : 0,
      });
    }
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ users: list });
  } catch (err) {
    console.error('[admin.users]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function loadUser(id) {
  const r = await client.execute('SELECT user_id, email, name FROM users WHERE user_id = ?', [types.Uuid.fromString(id)], { prepare: true });
  return r.first();
}

async function userAction(req, res) {
  const { id, action } = req.params;
  let user;
  try {
    user = await loadUser(id);
  } catch {
    return res.status(400).json({ error: 'Bad user id.' });
  }
  if (!user) return res.status(404).json({ error: 'No such user.' });
  const email = String(user.email || '').toLowerCase();
  try {
    if (action === 'revoke-sessions') {
      const n = await auth.endAllSessions(id);
      await audit(req, action, email, `${n} session(s)`);
      return res.json({ ok: true, sessionsEnded: n });
    }
    if (action === 'disable' || action === 'enable') {
      if (action === 'disable' && id === req.userId) return res.status(400).json({ error: 'You cannot disable your own account.' });
      const disabled = action === 'disable';
      await client.batch(
        [
          { query: 'UPDATE users SET disabled = ? WHERE user_id = ?', params: [disabled, user.user_id] },
          { query: 'UPDATE users_by_email SET disabled = ? WHERE email = ?', params: [disabled, user.email] },
        ],
        { prepare: true, logged: true }
      );
      let ended = 0;
      if (disabled) ended = await auth.endAllSessions(id);
      await audit(req, action, email, disabled ? `${ended} session(s) ended` : '');
      return res.json({ ok: true, disabled });
    }
    if (action === 'verify') {
      await client.batch(
        [
          { query: 'UPDATE users SET email_verified = true WHERE user_id = ?', params: [user.user_id] },
          { query: 'UPDATE users_by_email SET email_verified = true WHERE email = ?', params: [user.email] },
        ],
        { prepare: true, logged: true }
      );
      await audit(req, action, email);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('[admin.userAction]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------- audit + metrics
async function auditLog(req, res) {
  const items = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const r = await safe(
      () => client.execute('SELECT at, admin_email, action, target, detail FROM admin_audit WHERE day = ? LIMIT 200', [day], { prepare: true }),
      { rows: [] }
    );
    for (const x of r.rows || []) {
      items.push({ at: x.at.getDate().toISOString(), admin: x.admin_email, action: x.action, target: x.target, detail: x.detail });
    }
  }
  return res.json({ items });
}

function apiMetrics(req, res) {
  return res.json(metrics.snapshot());
}

module.exports = { overview, nodes, schema, rows, users, userAction, auditLog, apiMetrics };
