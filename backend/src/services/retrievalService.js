/**
 * retrievalService.js — talks to the smdb retrieval sidecar (a small Python service that
 * keeps a late-interaction index in Cassandra; see the StudyMateDb repository).
 *
 * What it gives the app: instead of sending EVERY chunk of a document to the LLM, the
 * chat and evaluator send only the few chunks that are relevant to the question.
 *
 * Switches (.env):
 *   RETRIEVAL_ENABLED=true|false   off by default; when off, or whenever the sidecar is
 *                                  unreachable or a document is not indexed yet, callers
 *                                  fall back to the old behaviour (whole document).
 *   RETRIEVAL_URL                  default http://127.0.0.1:8100
 *   RETRIEVAL_TOP_K                chunks handed to the LLM (default 5)
 *   RETRIEVAL_TIMEOUT_MS           per search request (default 8000)
 *
 * Index layout on the sidecar: one scope per document ("doc:<documentId>"); inside it each
 * chunk is addressed by its chunk_index. So a search never leaves the document's own
 * partitions, the same way document_chunks is partitioned by document_id.
 */
require('dotenv').config();
const { client } = require('../config/cassandra');

const ENABLED = String(process.env.RETRIEVAL_ENABLED || 'false').toLowerCase() === 'true';
const URL_BASE = (process.env.RETRIEVAL_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
const TOP_K = parseInt(process.env.RETRIEVAL_TOP_K || '5', 10);
const TIMEOUT_MS = parseInt(process.env.RETRIEVAL_TIMEOUT_MS || '8000', 10);
const INDEX_BATCH = 32;

// documentId -> { state: 'indexing'|'ready'|'failed', done, total, error? }  (in memory only)
const indexStatus = new Map();

const scopeOf = (documentId) => `doc:${documentId}`;

async function post(path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sidecar ${path} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Sidecar status for /api/health. Never throws. */
async function health() {
  if (!ENABLED) return { enabled: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${URL_BASE}/health`, { signal: ctrl.signal });
    const body = await res.json();
    return { enabled: true, reachable: res.ok, url: URL_BASE, encoder: body.encoder, config: body.config };
  } catch (err) {
    return { enabled: true, reachable: false, url: URL_BASE, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Index a document's chunks. Runs in the background (encoding takes roughly a second per
 * dozen chunks on a CPU), so uploads return immediately; until it finishes, questions on
 * that document use the whole-document fallback.
 * @param {string} documentId
 * @param {string[]} chunks  chunk texts, position = chunk_index
 */
function indexDocumentInBackground(documentId, chunks) {
  if (!ENABLED || !chunks.length) return;
  const id = String(documentId);
  const status = { state: 'indexing', done: 0, total: chunks.length, startedAt: Date.now() };
  indexStatus.set(id, status);
  (async () => {
    for (let i = 0; i < chunks.length; i += INDEX_BATCH) {
      const batch = chunks.slice(i, i + INDEX_BATCH).map((text, j) => ({ doc_id: String(i + j), text }));
      // a new document: its chunk ids cannot exist yet, so the sidecar may write the batch in bulk.
      // One retry, because a batch can time out while the sidecar is busy with something else.
      try {
        await post('/index', { scope: scopeOf(id), chunks: batch, replace: false }, 180000);
      } catch (err) {
        console.error(`[retrieval] batch at chunk ${i} of document ${id} failed (${err.message}); retrying once`);
        await post('/index', { scope: scopeOf(id), chunks: batch, replace: true }, 300000);
      }
      status.done = Math.min(chunks.length, i + INDEX_BATCH);
    }
    status.state = 'ready';
    status.finishedAt = Date.now();
    const secs = ((status.finishedAt - status.startedAt) / 1000).toFixed(0);
    console.log(`[retrieval] indexed document ${id}: ${chunks.length} chunks in ${secs}s`);
  })().catch((err) => {
    status.state = 'failed';
    status.error = err.message;
    console.error(`[retrieval] indexing document ${id} failed at ${status.done}/${status.total}:`, err.message);
  });
}

/** Documents being indexed right now (or finished / failed in the last few minutes). */
function activeIndexing() {
  const out = [];
  const now = Date.now();
  for (const [documentId, st] of indexStatus) {
    if (st.state === 'indexing' || (st.finishedAt && now - st.finishedAt < 5 * 60 * 1000) || st.state === 'failed') {
      out.push({ documentId, state: st.state, done: st.done, total: st.total, error: st.error });
    }
  }
  return out;
}

/** Same as above but waits for completion (used by the reindex script). */
async function indexDocument(documentId, chunks) {
  for (let i = 0; i < chunks.length; i += INDEX_BATCH) {
    const batch = chunks.slice(i, i + INDEX_BATCH).map((text, j) => ({ doc_id: String(i + j), text }));
    await post('/index', { scope: scopeOf(documentId), chunks: batch }, 120000);
  }
}

function getIndexStatus(documentId) {
  return indexStatus.get(String(documentId)) || { state: 'unknown' };
}

/** Remove a document from the index. Never throws. */
async function removeDocument(documentId, chunkCount) {
  if (!ENABLED || !chunkCount) return;
  indexStatus.delete(String(documentId));
  try {
    const ids = Array.from({ length: chunkCount }, (_, i) => String(i));
    await post('/delete', { scope: scopeOf(documentId), doc_ids: ids }, 30000);
  } catch (err) {
    console.error(`[retrieval] removing document ${documentId} failed:`, err.message);
  }
}

/**
 * Top chunks of one document for a question.
 *
 * With `focused`, the list is cut where relevance drops instead of always returning k: we look
 * `depth` results deep, place every score on a 0..1 scale between the deepest result and the
 * best one, and keep those above `keep` (at least `minK`, at most k). A query that matches a
 * few passages well and the rest only loosely therefore returns just the few. This is a
 * heuristic over relative scores, not a calibrated relevance threshold.
 *
 * @returns {Promise<Array<{chunkIndex:number, score:number}>|null>} null = retrieval unavailable
 */
async function search(documentId, query, k = TOP_K, focused = null) {
  if (!ENABLED) return null;
  const depth = focused ? Math.max(k, focused.depth || 30) : k;
  try {
    const body = await post(
      '/search',
      { scope: scopeOf(documentId), query, k: depth, planner: 'fixed', nprobe: 4, rerank: Math.max(20, depth) },
      TIMEOUT_MS
    );
    let hits = (body.results || []).map((r) => ({ chunkIndex: parseInt(r.doc_id, 10), score: r.score }));
    if (focused && hits.length > (focused.minK || 3)) {
      const top = hits[0].score;
      const floor = hits[hits.length - 1].score;
      const span = top - floor;
      const keep = focused.keep ?? 0.5;
      const minK = focused.minK || 3;
      hits = hits.filter((h, i) => i < minK || (span > 0 && (h.score - floor) / span >= keep));
    }
    return hits.slice(0, k);
  } catch (err) {
    console.error('[retrieval] search failed, falling back to the whole document:', err.message);
    return null;
  }
}

/**
 * Build the LLM context for a question about a document.
 *
 *   retrieval available and the document is indexed -> the top-k relevant chunks
 *   otherwise                                      -> every chunk, as before
 *
 * @returns {Promise<{context:string, mode:'retrieval'|'full-document'|'none', sources:Array, chunksUsed:number, chunksTotal:number|null}>}
 */
async function buildContext(documentId, query, k = TOP_K, focused = null) {
  if (!documentId) return { context: '', mode: 'none', sources: [], chunksUsed: 0, chunksTotal: null };

  const hits = query ? await search(documentId, query, k, focused) : null;
  if (hits && hits.length) {
    const rows = await client.execute(
      'SELECT chunk_index, chunk_text, page_number, section FROM document_chunks WHERE document_id = ? AND chunk_index IN ?',
      [documentId, hits.map((h) => h.chunkIndex)],
      { prepare: true }
    );
    const byIndex = new Map(rows.rows.map((r) => [r.chunk_index, r]));
    const sources = hits
      .filter((h) => byIndex.has(h.chunkIndex))
      .map((h) => ({
        chunkIndex: h.chunkIndex,
        page: byIndex.get(h.chunkIndex).page_number,
        section: byIndex.get(h.chunkIndex).section || null,
        score: Math.round(h.score * 1000) / 1000,
        preview: byIndex.get(h.chunkIndex).chunk_text.slice(0, 160),
      }));
    if (sources.length) {
      // each passage is labelled with where it comes from, when the document has that structure
      const context = sources
        .map((s) => (s.section ? `[${s.section}, p.${s.page}]\n` : '') + byIndex.get(s.chunkIndex).chunk_text)
        .join('\n\n');
      return { context, mode: 'retrieval', sources, chunksUsed: sources.length, chunksTotal: null };
    }
  }

  // fallback: the whole document (retrieval off, sidecar down, or document not indexed yet)
  const all = await client.execute(
    'SELECT chunk_text FROM document_chunks WHERE document_id = ?',
    [documentId],
    { prepare: true }
  );
  return {
    context: all.rows.map((r) => r.chunk_text).join(' '),
    mode: 'full-document',
    sources: [],
    chunksUsed: all.rowLength,
    chunksTotal: all.rowLength,
  };
}

/**
 * Live three-way comparison for one document: the sidecar indexes its chunks as (1) one vector
 * per chunk with Cassandra's vector index, (2) the ColBERT Live! design, (3) this app's index,
 * timing each. Returns the job (poll compareStatus). Throws with a readable message.
 */
async function startCompare(documentId, maxChunks = 300) {
  const rows = await client.execute(
    'SELECT chunk_index, chunk_text FROM document_chunks WHERE document_id = ?',
    [documentId],
    { prepare: true }
  );
  if (!rows.rowLength) {
    const err = new Error('This document has no chunks');
    err.status = 404;
    throw err;
  }
  const chunks = rows.rows.map((r) => r.chunk_text);
  const res = await fetch(`${URL_BASE}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chunks, max_chunks: maxChunks }),
  }).catch((e) => {
    const err = new Error(`The retrieval sidecar is not reachable at ${URL_BASE} (${e.message})`);
    err.status = 503;
    throw err;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.detail || `sidecar /compare -> HTTP ${res.status}`);
    err.status = res.status === 422 ? 400 : 503;
    throw err;
  }
  return body;
}

async function compareStatus(jobId) {
  const res = await fetch(`${URL_BASE}/compare/${encodeURIComponent(jobId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.detail || `sidecar /compare -> HTTP ${res.status}`);
    err.status = res.status === 404 ? 404 : 503;
    throw err;
  }
  return body;
}

async function sidecar(method, path, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || `sidecar ${path} -> HTTP ${res.status}`);
      err.status = [404, 409, 422].includes(res.status) ? (res.status === 422 ? 400 : res.status) : 503;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error(`The retrieval sidecar is not reachable at ${URL_BASE} (${e.message})`);
    err.status = 503;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One question through the three indexes of a finished comparison. */
const compareSearch = (jobId, query, k = 3) =>
  sidecar('POST', `/compare/${encodeURIComponent(jobId)}/search`, { query, k });

/** Random chunks of the comparison, to write self-test questions for. */
const compareSample = (jobId, n = 20) =>
  sidecar('GET', `/compare/${encodeURIComponent(jobId)}/sample?n=${n}`);

/** Known-item accuracy: items = [{ chunk, question }]. */
const compareSelfTest = (jobId, items) =>
  sidecar('POST', `/compare/${encodeURIComponent(jobId)}/selftest`, { items }, 300000);

/** Remove the comparison's data. Never throws. */
const compareClose = (jobId) =>
  sidecar('DELETE', `/compare/${encodeURIComponent(jobId)}`).catch(() => ({ closed: false }));

/**
 * Section-aware extraction of a PDF by the sidecar (outline -> chapters and sections, page
 * numbers, headers and footers removed). Throws when the sidecar cannot do it; the caller
 * then falls back to plain text extraction.
 * @param {Buffer} buffer
 */
async function extractPdf(buffer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(`${URL_BASE}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buffer,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `sidecar /extract -> HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  enabled: ENABLED,
  extractPdf,
  startCompare,
  compareStatus,
  compareSearch,
  compareSample,
  compareSelfTest,
  compareClose,
  health,
  indexDocument,
  indexDocumentInBackground,
  activeIndexing,
  getIndexStatus,
  removeDocument,
  search,
  buildContext,
};
