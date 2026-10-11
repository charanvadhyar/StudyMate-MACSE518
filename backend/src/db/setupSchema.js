/**
 * setupSchema.js
 * Reads schema.cql and executes each statement against Cassandra.
 * Run once before seeding:  npm run setup-db
 *
 * Connects WITHOUT a keyspace first (the keyspace is created by the script),
 * so it uses a bare client rather than the shared keyspace-bound client.
 */
const fs = require('fs');
const path = require('path');
const cassandra = require('cassandra-driver');
require('dotenv').config();

const contactPoints = (process.env.CASSANDRA_CONTACT_POINTS || '127.0.0.1').split(',');
const localDataCenter = process.env.CASSANDRA_LOCAL_DC || 'datacenter1';

const authProvider =
  process.env.CASSANDRA_USER && process.env.CASSANDRA_PASSWORD
    ? new cassandra.auth.PlainTextAuthProvider(
        process.env.CASSANDRA_USER,
        process.env.CASSANDRA_PASSWORD
      )
    : undefined;

async function run() {
  // which settings this process actually received (names and hosts only, never secrets)
  const seen = Object.keys(process.env).filter((k) => /^(CASSANDRA|RETRIEVAL|NODE_ENV|PORT|RAILWAY_SERVICE_NAME|RAILWAY_ENVIRONMENT_NAME)/.test(k)).sort();
  console.log(`[setup] service=${process.env.RAILWAY_SERVICE_NAME || 'local'} env=${process.env.RAILWAY_ENVIRONMENT_NAME || '-'} contact points=${contactPoints.join(',')}`);
  console.log(`[setup] settings present: ${seen.join(', ') || 'none'}`);
  // No keyspace here — schema.cql creates and USEs it.
  const client = new cassandra.Client({ contactPoints, localDataCenter, authProvider });
  await client.connect();
  console.log('[setup] connected');

  let cql = fs.readFileSync(path.join(__dirname, 'schema.cql'), 'utf8');
  // CASSANDRA_REPLICATION, e.g. "datacenter1:3" on the 3-node cluster: one copy of every row on
  // each node. Default keeps the single-node setting from schema.cql.
  const repl = (process.env.CASSANDRA_REPLICATION || '').trim();
  if (repl) {
    const dcs = repl.split(',').map((p) => p.split(':').map((x) => x.trim()));
    const map = dcs.map(([dc, n]) => `'${dc}': ${parseInt(n, 10)}`).join(', ');
    cql = cql.replace(/WITH replication = \{[^}]*\}/, `WITH replication = {'class': 'NetworkTopologyStrategy', ${map}}`);
    console.log(`[setup] replication: NetworkTopologyStrategy ${map}`);
  }

  // Split on ';' but ignore comment-only lines. Each CREATE statement runs separately.
  const statements = cql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 70);
    try {
      await client.execute(stmt);
      console.log(`[setup] OK   ${preview}...`);
    } catch (err) {
      console.error(`[setup] FAIL ${preview}...\n        ${err.message}`);
    }
  }

  if (repl) {
    const map = repl.split(',').map((p) => p.split(':').map((x) => x.trim()))
      .map(([dc, n]) => `'${dc}': ${parseInt(n, 10)}`).join(', ');
    // Only needed when the keyspace already existed with other settings. Cassandra refuses it
    // while a node is still joining, so a failure here is reported and start-up continues.
    try {
      const cur = await client.execute("SELECT replication FROM system_schema.keyspaces WHERE keyspace_name = 'studymate'");
      const want = Object.fromEntries(repl.split(',').map((p) => p.split(':').map((x) => x.trim())));
      const have = cur.first() ? cur.first().replication : {};
      const same = Object.entries(want).every(([dc, n]) => String(have[dc]) === String(parseInt(n, 10)));
      if (same) {
        console.log('[setup] keyspace replication already as configured');
      } else {
        await client.execute(`ALTER KEYSPACE studymate WITH replication = {'class': 'NetworkTopologyStrategy', ${map}}`);
        console.log('[setup] keyspace replication updated (run "nodetool repair" if it held data before)');
      }
    } catch (err) {
      console.warn(`[setup] could not change keyspace replication yet: ${err.message}`);
    }
  }
  await client.shutdown();
  console.log('[setup] done');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
