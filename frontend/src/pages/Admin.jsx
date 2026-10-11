import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../layout/AppShell';
import {
  adminOverview, adminNodes, adminSchema, adminRows, adminUsers, adminUserAction, adminAudit, adminMetrics,
} from '../api/endpoints';
import { errMsg } from '../api/client';
import { Button, Loading, ErrorBanner, StatCard, Modal, inputCls } from '../components/ui';

/*
 * Admin panel: cluster health, per-node internals, Cassandra schema and data browser,
 * accounts, admin audit log and API metrics. Only accounts in ADMIN_EMAILS reach it.
 */

const TABS = [
  ['overview', 'Overview'],
  ['nodes', 'Cluster nodes'],
  ['tables', 'Tables'],
  ['users', 'Users'],
  ['metrics', 'API metrics'],
  ['audit', 'Audit log'],
];

const fmtNum = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString());
const fmtDur = (s) => {
  if (s == null) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '–');

function useLoad(fn, deps = []) {
  const [state, set] = useState({ data: null, error: '', loading: true });
  const load = useCallback(() => {
    set((s) => ({ ...s, loading: true, error: '' }));
    return fn()
      .then((data) => set({ data, error: '', loading: false }))
      .catch((err) => set({ data: null, error: errMsg(err, 'Could not load'), loading: false }));
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function Dot({ ok, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-good' : 'bg-bad'}`} />
      {label}
    </span>
  );
}

function Panel({ title, action, children }) {
  return (
    <section className="border border-divider rounded-lg bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-divider">
        <h2 className="font-heading text-lg">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Table({ head, rows, empty = 'Nothing here yet.' }) {
  if (!rows.length) return <p className="text-sm text-n-600">{empty}</p>;
  return (
    <div className="overflow-x-auto sm-scroll">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-n-600 border-b border-divider">
            {head.map((h, i) => <th key={i} className="py-2 pr-4 font-normal whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-divider/50 align-top">
              {r.map((c, j) => <td key={j} className="py-2 pr-4">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- overview
function Overview() {
  const { data, error, loading, reload } = useLoad(adminOverview);
  useEffect(() => {
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [reload]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  const { cluster, keyspaces, counts, services, indexing, api } = data;
  const up = cluster.nodes.filter((n) => n.up).length;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Cassandra nodes up" value={`${up} / ${cluster.nodes.length}`} note={`consistency ${cluster.consistency}`} />
        <StatCard label="Users" value={fmtNum(counts.users)} note={`${fmtNum(counts.sessions)} active sessions`} />
        <StatCard label="Documents" value={fmtNum(counts.documents)} note={`${fmtNum(counts.document_chunks)} passages`} />
        <StatCard label="API requests" value={fmtNum(api.totalRequests)} note={`${(api.errorRate * 100).toFixed(1)}% server errors, up ${fmtDur(api.uptimeSeconds)}`} />
      </div>

      <Panel title="Cluster" action={<span className="text-xs text-n-600">refreshes every 10 s</span>}>
        <div className="grid sm:grid-cols-3 gap-3">
          {cluster.nodes.map((n) => (
            <div key={n.address} className={`rounded-md border p-3 ${n.up ? 'border-good/40 bg-good/5' : 'border-bad/40 bg-bad/5'}`}>
              <Dot ok={n.up} label={<span className="font-medium">{n.address}</span>} />
              <div className="text-xs text-n-600 mt-1">
                {n.datacenter} · {n.rack} · Cassandra {n.version || '?'}
              </div>
              <div className="text-xs mt-1">{n.up ? 'Up' : 'Down: reads and writes continue on the other replicas'}</div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Table
            head={['Keyspace', 'Replication']}
            rows={keyspaces.map((k) => [
              <span className="font-mono text-xs">{k.name}</span>,
              <span className="font-mono text-xs">
                {Object.entries(k.replication).filter(([key]) => key !== 'class').map(([dc, rf]) => `${dc}: ${rf}`).join(', ')}{' '}
                <span className="text-n-500">({String(k.replication.class).split('.').pop()})</span>
              </span>,
            ])}
          />
        </div>
      </Panel>

      <div className="grid lg:grid-cols-2 gap-6">
        <Panel title="Services">
          <div className="flex flex-col gap-2 text-sm">
            <Dot ok label={`API · Node ${services.api.node} · ${services.api.memoryMb} MB · up ${fmtDur(services.api.uptimeSeconds)}`} />
            <Dot
              ok={services.retrieval.enabled && services.retrieval.reachable}
              label={
                !services.retrieval.enabled ? 'Retrieval index: off (whole-document mode)'
                  : services.retrieval.reachable ? `Retrieval index: reachable${services.retrieval.encoder ? ` · ${services.retrieval.encoder.model || ''}` : ''}`
                  : `Retrieval index: unreachable (${services.retrieval.error || 'no answer'})`
              }
            />
            <Dot ok={services.llm.configured} label={`LLM: ${services.llm.configured ? `${services.llm.provider} ${services.llm.model || ''}` : 'not configured (fallback answers)'}`} />
            <Dot ok={services.email.configured} label={services.email.configured ? 'Email: sending through Brevo' : 'Email: not configured (links go to the server log)'} />
          </div>
        </Panel>
        <Panel title="Rows per table">
          <Table
            head={['Table', 'Rows']}
            rows={Object.entries(counts).map(([t, n]) => [<span className="font-mono text-xs">{t}</span>, n && n.error ? <span className="text-bad text-xs">{n.error}</span> : fmtNum(n)])}
          />
        </Panel>
      </div>

      <Panel title="Documents being indexed">
        <Table
          empty="No indexing running."
          head={['Document', 'State', 'Progress']}
          rows={indexing.map((j) => [<span className="font-mono text-xs">{j.documentId}</span>, j.state, `${j.done} / ${j.total}`])}
        />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- nodes
function Nodes() {
  const { data, error, loading, reload } = useLoad(adminNodes);
  if (loading && !data) return <Loading label="Asking each node…" />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end"><Button variant="ghost" onClick={reload} busy={loading}>Refresh</Button></div>
      {data.nodes.map((n) => (
        <Panel key={n.address} title={<span className="flex items-center gap-3"><Dot ok={n.up} label={n.address} /></span>}
          action={<span className="text-xs text-n-600">{n.datacenter} · {n.rack}{n.version ? ` · ${n.version}` : ''}</span>}>
          {!n.up ? (
            <p className="text-sm text-bad">The driver cannot reach this node. The rest of the cluster keeps serving at {data.consistency}.</p>
          ) : (
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Tokens" value={fmtNum(n.tokens)} />
                  <StatCard label="Client connections" value={fmtNum(n.clients?.connections)} />
                  <StatCard label="Data on disk" value={`${Object.values(n.diskMiB || {}).reduce((a, b) => a + b, 0).toFixed(1)} MiB`} />
                </div>
                <div>
                  <h3 className="text-xs text-n-600 mb-1">Disk per keyspace</h3>
                  <Table head={['Keyspace', 'MiB']} rows={Object.entries(n.diskMiB || {}).map(([k, v]) => [<span className="font-mono text-xs">{k}</span>, v.toFixed(2)])} empty="Not available on this Cassandra version." />
                </div>
                <div>
                  <h3 className="text-xs text-n-600 mb-1">Caches</h3>
                  <Table head={['Cache', 'Entries', 'Hit ratio', 'Size']} rows={(n.caches || []).map((c) => [c.name, fmtNum(c.entries), Number.isFinite(c.hitRatio) ? `${(c.hitRatio * 100).toFixed(1)}%` : '–', `${(c.sizeBytes / 1048576).toFixed(1)} MB`])} />
                </div>
              </div>
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-xs text-n-600 mb-1">Busiest tables: local reads</h3>
                  <Table head={['Table', 'Reads', 'p50 ms', 'p99 ms']} rows={(n.latency?.reads || []).map((r) => [<span className="font-mono text-xs">{r.table}</span>, fmtNum(r.count), r.p50.toFixed(2), r.p99.toFixed(2)])} />
                </div>
                <div>
                  <h3 className="text-xs text-n-600 mb-1">Busiest tables: local writes</h3>
                  <Table head={['Table', 'Writes', 'p50 ms', 'p99 ms']} rows={(n.latency?.writes || []).map((r) => [<span className="font-mono text-xs">{r.table}</span>, fmtNum(r.count), r.p50.toFixed(2), r.p99.toFixed(2)])} />
                </div>
                <div>
                  <h3 className="text-xs text-n-600 mb-1">Thread pools</h3>
                  <Table head={['Pool', 'Active', 'Pending', 'Blocked', 'Completed']} rows={(n.threadPools || []).map((p) => [p.name, p.active, <span className={p.pending ? 'text-warn' : ''}>{p.pending}</span>, <span className={p.blocked ? 'text-bad' : ''}>{p.blocked}</span>, fmtNum(p.completed)])} />
                </div>
              </div>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tables
function Cell({ v }) {
  if (v === null || v === undefined) return <span className="text-n-400">null</span>;
  if (typeof v === 'object') return <span className="font-mono text-xs">{JSON.stringify(v)}</span>;
  if (v === '[redacted]') return <span className="text-n-500 italic">redacted</span>;
  return <span className="font-mono text-xs break-words">{String(v)}</span>;
}

function Tables() {
  const { data, error, loading, reload } = useLoad(adminSchema);
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState('schema');
  const all = useMemo(() => (data ? data.keyspaces.flatMap((k) => k.tables.map((t) => ({ ks: k.name, t }))) : []), [data]);
  useEffect(() => {
    if (!sel && all.length) setSel(all[0]);
  }, [all, sel]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;

  return (
    <div className="grid lg:grid-cols-[260px_1fr] gap-6">
      <div className="border border-divider rounded-lg p-2 max-h-[75vh] overflow-auto sm-scroll">
        {data.keyspaces.map((k) => (
          <div key={k.name} className="mb-3">
            <div className="px-2 py-1 text-xs text-n-600">{k.name}</div>
            {k.tables.map((t) => {
              const active = sel && sel.ks === k.name && sel.t.name === t.name;
              return (
                <button key={t.name} onClick={() => setSel({ ks: k.name, t })}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm font-mono ${active ? 'bg-accent/10 text-accent' : 'hover:bg-ink/5'}`}>
                  {t.name}
                  {t.counter && <span className="ml-1 text-[10px] text-n-500">counter</span>}
                  {t.defaultTtl > 0 && <span className="ml-1 text-[10px] text-n-500">TTL</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {sel && (
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-heading text-xl font-mono">{sel.ks}.{sel.t.name}</h2>
            <div className="flex gap-1 border border-divider rounded-md p-0.5">
              {['schema', 'data'].map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 text-sm rounded ${mode === m ? 'bg-accent text-white' : ''}`}>
                  {m === 'schema' ? 'Schema' : 'Data'}
                </button>
              ))}
            </div>
          </div>
          {mode === 'schema' ? <SchemaView ks={sel.ks} t={sel.t} /> : <RowBrowser key={`${sel.ks}.${sel.t.name}`} ks={sel.ks} table={sel.t} />}
        </div>
      )}
    </div>
  );
}

function SchemaView({ ks, t }) {
  const pk = t.partitionKey.length > 1 ? `(${t.partitionKey.join(', ')})` : t.partitionKey[0];
  const ddl = `CREATE TABLE ${ks}.${t.name} (\n${t.columns.map((c) => `    ${c.name} ${c.type}`).join(',\n')},\n    PRIMARY KEY (${[pk, ...t.clusteringKey.map((c) => c.split(' ')[0])].join(', ')})\n)${t.clusteringKey.length ? ` WITH CLUSTERING ORDER BY (${t.clusteringKey.join(', ')})` : ''}${t.defaultTtl ? `\n  ${t.clusteringKey.length ? 'AND' : 'WITH'} default_time_to_live = ${t.defaultTtl}` : ''};`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid sm:grid-cols-4 gap-3">
        <StatCard label="Partition key" value={<span className="font-mono text-base">{t.partitionKey.join(', ')}</span>} />
        <StatCard label="Clustering" value={<span className="font-mono text-base">{t.clusteringKey.join(', ') || 'none'}</span>} />
        <StatCard label="Default TTL" value={t.defaultTtl ? fmtDur(t.defaultTtl) : 'none'} />
        <StatCard label="Compaction" value={<span className="text-base">{t.compaction}</span>} />
      </div>
      <Table
        head={['Column', 'Type', 'Role']}
        rows={t.columns.map((c) => [
          <span className="font-mono text-xs">{c.name}</span>,
          <span className="font-mono text-xs">{c.type}</span>,
          c.kind === 'partition_key' ? 'partition key' : c.kind === 'clustering' ? `clustering (${c.order})` : c.kind,
        ])}
      />
      {t.indexes.length > 0 && (
        <Table head={['Index', 'Target', 'Kind']} rows={t.indexes.map((i) => [i.name, <span className="font-mono text-xs">{i.target}</span>, i.class || i.kind])} />
      )}
      <pre className="font-mono text-xs bg-n-100 rounded-md p-3 overflow-x-auto sm-scroll">{ddl}</pre>
    </div>
  );
}

function RowBrowser({ ks, table }) {
  // paging keeps a history of page states so "Previous" works
  const [history, setHistory] = useState([null]);
  const [data, setData] = useState(null);
  const [where, setWhere] = useState({});
  const [applied, setApplied] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pk = table.partitionKey;

  const load = useCallback(async (pageState, filter) => {
    setBusy(true);
    setError('');
    try {
      setData(await adminRows(ks, table.name, { pageState, where: filter || undefined }));
    } catch (err) {
      setError(errMsg(err, 'Could not read the table'));
    } finally {
      setBusy(false);
    }
  }, [ks, table.name]);

  useEffect(() => { load(null, null); }, [load]);

  const go = (states, filter) => {
    setHistory(states);
    load(states[states.length - 1], filter);
  };

  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(where); go([null], where); }}>
        {pk.map((k) => (
          <label key={k} className="flex flex-col text-xs text-n-600">
            {k}
            <input className={`${inputCls} w-72 font-mono`} value={where[k] || ''} onChange={(e) => setWhere((w) => ({ ...w, [k]: e.target.value }))} placeholder="partition key value" />
          </label>
        ))}
        <Button type="submit" variant="ghost" disabled={busy || pk.some((k) => !where[k])}>Read one partition</Button>
        {applied && <Button type="button" variant="ghost" onClick={() => { setApplied(null); setWhere({}); go([null], null); }}>Show all</Button>}
      </form>
      {data && <p className="font-mono text-xs text-n-600 bg-n-100 rounded px-2 py-1">{data.cql}</p>}
      <ErrorBanner message={error} />
      {busy || !data ? <Loading /> : (
        <div className="overflow-x-auto sm-scroll border border-divider rounded-md">
          <table className="text-sm min-w-full">
            <thead>
              <tr className="text-left border-b border-divider bg-n-100">
                {data.columns.map((c) => (
                  <th key={c.name} className="py-2 px-3 font-normal whitespace-nowrap align-bottom">
                    <div className="font-mono text-xs text-ink">{c.name}</div>
                    <div className="text-[10px] text-n-500">{c.type}{c.kind === 'partition_key' ? ' · partition key' : c.kind === 'clustering' ? ' · clustering' : ''}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && <tr><td className="p-3 text-n-600" colSpan={data.columns.length || 1}>No rows.</td></tr>}
              {data.rows.map((r, i) => (
                <tr key={i} className="border-b border-divider/50 align-top">
                  {data.columns.map((c) => <td key={c.name} className="py-1.5 px-3 max-w-xs"><Cell v={r[c.name]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2 justify-between items-center">
        <span className="text-xs text-n-600">Page {history.length}</span>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy || history.length < 2} onClick={() => go(history.slice(0, -1), applied)}>Previous</Button>
          <Button variant="ghost" disabled={busy || !data?.nextPageState} onClick={() => go([...history, data.nextPageState], applied)}>Next page</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- users
function Users() {
  const { data, error, loading, reload } = useLoad(adminUsers);
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  const list = data.users.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));

  async function run() {
    setBusy(true);
    try {
      await adminUserAction(confirm.user.userId, confirm.action);
      setMsg(`${confirm.label}: done for ${confirm.user.email}.`);
      setConfirm(null);
      reload();
    } catch (err) {
      setMsg(errMsg(err, 'Action failed'));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }
  const ask = (user, action, label, text) => setConfirm({ user, action, label, text });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 items-center justify-between flex-wrap">
        <input className={`${inputCls} max-w-xs`} placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-sm text-n-600">{list.length} of {data.users.length} accounts</span>
      </div>
      {msg && <p className="text-sm">{msg}</p>}
      <Table
        head={['Account', 'Status', 'Joined', 'Docs', 'Quizzes', 'Evals', 'Messages', 'Sessions', '']}
        rows={list.map((u) => [
          <div><div className="font-medium">{u.name}{u.admin && <span className="ml-2 text-[10px] text-accent">admin</span>}</div><div className="text-xs text-n-600">{u.email}</div></div>,
          u.disabled ? <span className="text-bad">Disabled</span> : u.verified ? <span className="text-good">Active</span> : <span className="text-warn">Unconfirmed</span>,
          <span className="text-xs">{fmtDate(u.createdAt)}</span>,
          u.documents, u.quizzes, u.evaluations, u.messages, fmtNum(u.sessions),
          <div className="flex gap-2 flex-wrap justify-end">
            {!u.verified && <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => ask(u, 'verify', 'Confirm email', `Mark ${u.email} as confirmed without the email link?`)}>Confirm</Button>}
            <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={!u.sessions} onClick={() => ask(u, 'revoke-sessions', 'Sign out everywhere', `End all ${u.sessions} session(s) of ${u.email}? They will have to sign in again.`)}>Sign out</Button>
            {u.disabled
              ? <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => ask(u, 'enable', 'Enable account', `Allow ${u.email} to sign in again?`)}>Enable</Button>
              : <Button variant="danger" className="!px-2 !py-1 text-xs" onClick={() => ask(u, 'disable', 'Disable account', `Disable ${u.email}? Their sessions end now and they cannot sign in until enabled.`)}>Disable</Button>}
          </div>,
        ])}
      />
      <Modal open={Boolean(confirm)} title={confirm?.label} onClose={() => setConfirm(null)}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant={confirm?.action === 'disable' ? 'danger' : 'primary'} busy={busy} onClick={run}>{confirm?.label}</Button></>}>
        <p className="text-sm">{confirm?.text}</p>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------- metrics
function Metrics() {
  const { data, error, loading, reload } = useLoad(adminMetrics);
  useEffect(() => {
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [reload]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  const max = Math.max(1, ...data.lastHour.map((m) => m.requests));
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Requests" value={fmtNum(data.totalRequests)} note={`since ${fmtDate(data.since)}`} />
        <StatCard label="Server errors" value={fmtNum(data.serverErrors)} note={`${(data.errorRate * 100).toFixed(2)}% of requests`} />
        <StatCard label="Last minute" value={fmtNum(data.lastHour[data.lastHour.length - 1].requests)} note="requests" />
        <StatCard label="Uptime" value={fmtDur(data.uptimeSeconds)} />
      </div>
      <Panel title="Requests per minute, last hour">
        <div className="flex items-end gap-[2px] h-32" role="img" aria-label="Requests per minute over the last hour">
          {data.lastHour.map((m) => (
            <div key={m.minute} title={`${new Date(m.minute).toLocaleTimeString()}: ${m.requests} requests, ${m.errors} errors, avg ${m.avgMs} ms`}
              className={`flex-1 rounded-t ${m.errors ? 'bg-bad/70' : 'bg-accent/70'}`} style={{ height: `${(m.requests / max) * 100}%`, minHeight: m.requests ? 2 : 0 }} />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-n-500 mt-1"><span>60 min ago</span><span>now</span></div>
      </Panel>
      <Panel title="Routes">
        <Table
          head={['Route', 'Requests', '4xx', '5xx', 'p50 ms', 'p95 ms', 'max ms']}
          rows={data.routes.map((r) => [<span className="font-mono text-xs">{r.route}</span>, fmtNum(r.count), r.clientErrors, <span className={r.serverErrors ? 'text-bad' : ''}>{r.serverErrors}</span>, r.p50, r.p95, r.max])}
        />
      </Panel>
      <Panel title="Recent server errors">
        <Table empty="No server errors since start-up." head={['When', 'Route', 'Status', 'ms']} rows={data.recentErrors.map((e) => [fmtDate(e.at), <span className="font-mono text-xs">{e.route}</span>, e.status, e.ms])} />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- audit
function Audit() {
  const { data, error, loading, reload } = useLoad(adminAudit);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  return (
    <Panel title="Admin actions, last 7 days" action={<Button variant="ghost" onClick={reload}>Refresh</Button>}>
      <Table empty="No admin actions yet." head={['When', 'Admin', 'Action', 'Account', 'Detail']}
        rows={data.items.map((a) => [fmtDate(a.at), a.admin, a.action, a.target, a.detail])} />
    </Panel>
  );
}

// ---------------------------------------------------------------- page
export default function Admin() {
  const [tab, setTab] = useState('overview');
  return (
    <div className="pb-12">
      <PageHeader title="Admin" subtitle="Cluster health, data and accounts" />
      <div className="px-6 md:px-8">
        <div className="flex gap-1 border-b border-divider mb-6 overflow-x-auto sm-scroll">
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === id ? 'border-accent text-accent' : 'border-transparent text-n-600 hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'overview' && <Overview />}
        {tab === 'nodes' && <Nodes />}
        {tab === 'tables' && <Tables />}
        {tab === 'users' && <Users />}
        {tab === 'metrics' && <Metrics />}
        {tab === 'audit' && <Audit />}
      </div>
    </div>
  );
}
