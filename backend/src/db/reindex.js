/**
 * reindex.js — push every stored document's chunks to the retrieval sidecar.
 * Use it once after enabling retrieval, so documents uploaded (or seeded) earlier
 * become searchable:   npm run reindex
 *
 * Needs RETRIEVAL_ENABLED=true in .env and the sidecar running.
 */
require('dotenv').config();
const { client, connect } = require('../config/cassandra');
const retrieval = require('../services/retrievalService');

async function run() {
  if (!retrieval.enabled) {
    console.error('[reindex] RETRIEVAL_ENABLED is not true in .env; nothing to do');
    process.exit(1);
  }
  const h = await retrieval.health();
  if (!h.reachable) {
    console.error(`[reindex] sidecar not reachable at ${h.url}: ${h.error || 'no response'}`);
    process.exit(1);
  }
  await connect();
  const docs = await client.execute('SELECT document_id, title FROM document_meta');
  console.log(`[reindex] ${docs.rowLength} documents`);
  let done = 0;
  let chunksTotal = 0;
  const started = Date.now();
  for (const d of docs.rows) {
    const rows = await client.execute(
      'SELECT chunk_index, chunk_text, section FROM document_chunks WHERE document_id = ?',
      [d.document_id],
      { prepare: true }
    );
    // chunk_index must be dense 0..n-1 for the index ids to line up; skip odd documents
    const texts = [];
    rows.rows.forEach((r) => { texts[r.chunk_index] = r.section ? `${r.section}. ${r.chunk_text}` : r.chunk_text; });
    if (!texts.length || texts.includes(undefined)) {
      console.log(`[reindex] skipped ${d.document_id} (${d.title}): no chunks or gaps in chunk_index`);
      continue;
    }
    await retrieval.indexDocument(d.document_id.toString(), texts);
    done += 1;
    chunksTotal += texts.length;
    if (done % 10 === 0) console.log(`[reindex] ${done}/${docs.rowLength} documents`);
  }
  const secs = (Date.now() - started) / 1000;
  console.log(`[reindex] indexed ${done} documents, ${chunksTotal} chunks in ${secs.toFixed(0)}s`);
  await client.shutdown();
}

run().catch((err) => {
  console.error('[reindex] failed:', err.message);
  process.exit(1);
});
