/**
 * Cassandra connection module.
 * Exports a singleton `client` connected to the studymate keyspace,
 * plus a `connect()` helper used at server startup.
 */
const cassandra = require('cassandra-driver');
require('dotenv').config();

const contactPoints = (process.env.CASSANDRA_CONTACT_POINTS || '127.0.0.1').split(',');
const localDataCenter = process.env.CASSANDRA_LOCAL_DC || 'datacenter1';
const keyspace = process.env.CASSANDRA_KEYSPACE || 'studymate';

// Optional username/password auth (leave blank for a default local cluster)
const authProvider =
  process.env.CASSANDRA_USER && process.env.CASSANDRA_PASSWORD
    ? new cassandra.auth.PlainTextAuthProvider(
        process.env.CASSANDRA_USER,
        process.env.CASSANDRA_PASSWORD
      )
    : undefined;

// On a multi-node cluster every read and write goes to a majority of the replicas
// (LOCAL_QUORUM: 2 of 3 with replication factor 3), so the app keeps working, and keeps
// reading its own writes, while any one node is down. Single node: set LOCAL_ONE.
const consistencyName = (process.env.CASSANDRA_CONSISTENCY || 'LOCAL_QUORUM').toUpperCase();
const consistency = cassandra.types.consistencies[
  consistencyName.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase())
];
if (consistency === undefined) throw new Error(`Unknown CASSANDRA_CONSISTENCY ${consistencyName}`);

const client = new cassandra.Client({
  contactPoints,
  localDataCenter,
  keyspace,
  authProvider,
  queryOptions: { consistency },
  socketOptions: { connectTimeout: 10000, readTimeout: 20000 },
});

// Additive schema changes for databases created before a column existed. Safe to run on
// every start: "already exists" is the expected answer the second time.
async function migrate() {
  const steps = [
    'ALTER TABLE document_chunks ADD section text',
    // email verification; accounts created before it existed have null and count as verified
    'ALTER TABLE users ADD email_verified boolean',
    'ALTER TABLE users_by_email ADD email_verified boolean',
    // set by an admin; a disabled account cannot sign in
    'ALTER TABLE users ADD disabled boolean',
    'ALTER TABLE users_by_email ADD disabled boolean',
    ...AUTH_TABLES,
  ];
  for (const cql of steps) {
    try {
      await client.execute(cql);
      console.log(`[cassandra] applied: ${cql}`);
    } catch (err) {
      if (!/already exist|conflicts with an existing column/i.test(err.message)) throw err;
    }
  }
}

// tables for sessions, email tokens and login throttling (also in schema.cql)
const AUTH_TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
     session_id uuid PRIMARY KEY, user_id uuid, refresh_hash text,
     created_at timestamp, last_used_at timestamp, user_agent text
   ) WITH default_time_to_live = 2592000`,
  `CREATE TABLE IF NOT EXISTS sessions_by_user (
     user_id uuid, session_id uuid, created_at timestamp, user_agent text,
     PRIMARY KEY (user_id, session_id)
   ) WITH default_time_to_live = 2592000`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
     token_hash text PRIMARY KEY, purpose text, user_id uuid, email text, created_at timestamp
   )`,
  `CREATE TABLE IF NOT EXISTS login_failures (
     email text, failed_at timeuuid, ip text,
     PRIMARY KEY (email, failed_at)
   ) WITH CLUSTERING ORDER BY (failed_at DESC) AND default_time_to_live = 900`,
  `CREATE TABLE IF NOT EXISTS admin_audit (
     day text, at timeuuid, admin_email text, action text, target text, detail text,
     PRIMARY KEY (day, at)
   ) WITH CLUSTERING ORDER BY (at DESC) AND default_time_to_live = 7776000`,
];

async function connect() {
  await client.connect();
  await migrate();
  const hosts = client.getState().getConnectedHosts().length;
  console.log(`[cassandra] connected to keyspace "${keyspace}" @ ${contactPoints.join(',')} ` +
    `(${client.hosts.length} node(s) known, ${hosts} connected, consistency ${consistencyName})`);
}

module.exports = { client, connect, keyspace, contactPoints, localDataCenter, consistencyName, cassandra };
