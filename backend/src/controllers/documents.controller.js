/**
 * documents.controller.js — CRUD for documents + on-demand summarization.
 * Demonstrates: multi-table writes (documents + chunks), partition reads,
 * integration with the AI summarization service, and handing new chunks to the
 * retrieval index (services/retrievalService.js).
 */
const { v4: uuidv4 } = require('uuid');
const { types, concurrent } = require('cassandra-driver');
const { client } = require('../config/cassandra');
const llm = require('../services/llmService');
const analytics = require('../services/analyticsWrites');
const retrieval = require('../services/retrievalService');
const { chunkText } = require('../services/chunker');

/**
 * Store a document and its chunks, then hand the chunks to the retrieval index.
 * @param {Array<{text:string, indexedText?:string, page?:number, section?:string}>} chunks
 */
async function storeDocument({ userId, title, subject, fileUrl, chunks }) {
  const documentId = uuidv4();
  const uploadedAt = new Date();

  await client.execute(
    'INSERT INTO documents (user_id, uploaded_at, document_id, title, subject, file_url, page_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, uploadedAt, documentId, title, subject || 'General', fileUrl || null, chunks.length],
    { prepare: true }
  );

  // insert chunks (concurrent single-row writes: one big batch would exceed Cassandra's
  // batch size limit for anything longer than a few pages)
  if (chunks.length) {
    await concurrent.executeConcurrent(
      client,
      'INSERT INTO document_chunks (document_id, chunk_index, chunk_text, page_number, section) VALUES (?, ?, ?, ?, ?)',
      chunks.map((c, idx) => [types.Uuid.fromString(documentId), idx, c.text, c.page || 1, c.section || null]),
      { concurrencyLevel: 32 }
    );
  }

  // write document_meta so this doc's subject/title is resolvable by id
  await client.execute(
    'INSERT INTO document_meta (document_id, user_id, title, subject, uploaded_at) VALUES (?, ?, ?, ?, ?)',
    [documentId, userId, title, subject || 'General', uploadedAt],
    { prepare: true }
  );

  // read-heavy table maintenance (counters + activity feed)
  await analytics.onDocumentCreated(userId, `Uploaded "${title}"`);

  // hand the chunks to the retrieval index (background; the upload does not wait for it).
  // The indexed text carries the section heading when there is one, so a chunk keeps its context.
  retrieval.indexDocumentInBackground(documentId, chunks.map((c) => c.indexedText || c.text));

  return { documentId, title, chunks: chunks.length, retrieval: retrieval.enabled ? 'indexing' : 'disabled' };
}

// CREATE — accepts extracted text, stores document + chunks
async function createDocument(req, res) {
  try {
    const { title, subject, text, fileUrl } = req.body;
    if (!title || !text) {
      return res.status(400).json({ error: 'title and text are required' });
    }
    // chunk the text on paragraph / sentence boundaries (~160 words per chunk)
    const chunks = chunkText(text).map((t) => ({ text: t }));
    const out = await storeDocument({ userId: req.userId, title, subject, fileUrl, chunks });
    return res.status(201).json({ ...out, structure: 'plain-text' });
  } catch (err) {
    console.error('[createDocument]', err);
    return res.status(500).json({ error: 'Failed to create document' });
  }
}

// CREATE from a PDF file — keeps the document's structure.
// The sidecar reads the PDF's outline, so every chunk knows its chapter, section and page;
// that context is indexed with the chunk and shown with answers. If the sidecar cannot read
// the file (not running, scanned PDF), the text is extracted here and chunked as plain text.
async function uploadPdf(req, res) {
  try {
    const { title, subject } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'a PDF file is required' });

    let chunks;
    let structure = 'sections';
    let note;
    try {
      const out = await retrieval.extractPdf(req.file.buffer);
      chunks = out.chunks.map((c) => ({
        text: c.text,
        indexedText: c.indexed_text,
        page: c.page_start,
        section: c.section || null,
      }));
      if (!out.with_sections) structure = 'pages';
    } catch (err) {
      console.error('[uploadPdf] structured extraction unavailable, using plain text:', err.message);
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(req.file.buffer);
      chunks = chunkText(parsed.text || '').map((t) => ({ text: t }));
      structure = 'plain-text';
      note = `Sections and page numbers were not kept (${err.message}).`;
    }
    if (!chunks.length) return res.status(422).json({ error: 'No text could be extracted from that PDF' });

    const out = await storeDocument({ userId: req.userId, title, subject, fileUrl: req.file.originalname, chunks });
    return res.status(201).json({ ...out, structure, note });
  } catch (err) {
    console.error('[uploadPdf]', err);
    return res.status(500).json({ error: 'Failed to upload document' });
  }
}

// READ (list) — all documents for the logged-in user, newest first
async function listDocuments(req, res) {
  try {
    const result = await client.execute(
      'SELECT user_id, uploaded_at, document_id, title, subject, page_count FROM documents WHERE user_id = ?',
      [req.userId],
      { prepare: true }
    );
    return res.json(result.rows.map(rowToDoc));
  } catch (err) {
    console.error('[listDocuments]', err);
    return res.status(500).json({ error: 'Failed to list documents' });
  }
}

// READ (one) — document chunks assembled in order
async function getDocument(req, res) {
  try {
    const { documentId } = req.params;
    const chunks = await client.execute(
      'SELECT chunk_index, chunk_text, page_number, section FROM document_chunks WHERE document_id = ?',
      [documentId],
      { prepare: true }
    );
    return res.json({
      documentId,
      chunks: chunks.rows.map((r) => ({
        index: r.chunk_index,
        text: r.chunk_text,
        page: r.page_number,
        section: r.section || null,
      })),
    });
  } catch (err) {
    console.error('[getDocument]', err);
    return res.status(500).json({ error: 'Failed to fetch document' });
  }
}

// UPDATE — title/subject (must supply uploaded_at as part of the key)
async function updateDocument(req, res) {
  try {
    const { documentId } = req.params;
    const { uploadedAt, title, subject } = req.body;
    if (!uploadedAt) {
      return res.status(400).json({ error: 'uploadedAt (clustering key) is required to update' });
    }
    await client.execute(
      'UPDATE documents SET title = ?, subject = ? WHERE user_id = ? AND uploaded_at = ? AND document_id = ?',
      [title, subject, req.userId, new Date(uploadedAt), types.Uuid.fromString(documentId)],
      { prepare: true }
    );
    return res.json({ documentId, title, subject });
  } catch (err) {
    console.error('[updateDocument]', err);
    return res.status(500).json({ error: 'Failed to update document' });
  }
}

// DELETE — remove document row + its chunks + summary
async function deleteDocument(req, res) {
  try {
    const { documentId } = req.params;
    const { uploadedAt } = req.body;
    if (!uploadedAt) {
      return res.status(400).json({ error: 'uploadedAt (clustering key) is required to delete' });
    }
    await client.execute(
      'DELETE FROM documents WHERE user_id = ? AND uploaded_at = ? AND document_id = ?',
      [req.userId, new Date(uploadedAt), types.Uuid.fromString(documentId)],
      { prepare: true }
    );
    const count = await client.execute(
      'SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?', [documentId], { prepare: true });
    await retrieval.removeDocument(documentId, Number(count.first().n));
    await client.execute('DELETE FROM document_chunks WHERE document_id = ?', [documentId], { prepare: true });
    await client.execute('DELETE FROM summaries WHERE document_id = ?', [documentId], { prepare: true });
    await client.execute('DELETE FROM document_meta WHERE document_id = ?', [documentId], { prepare: true });
    return res.json({ deleted: documentId });
  } catch (err) {
    console.error('[deleteDocument]', err);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
}

// SUMMARIZE — generate + store a summary for a document
async function summarizeDocument(req, res) {
  try {
    const { documentId } = req.params;
    const chunks = await client.execute(
      'SELECT chunk_text FROM document_chunks WHERE document_id = ?',
      [documentId],
      { prepare: true }
    );
    const fullText = chunks.rows.map((r) => r.chunk_text).join(' ');
    const summary = await llm.summarizeText(fullText);

    await client.execute(
      'INSERT INTO summaries (document_id, summary_text, generated_at) VALUES (?, ?, ?)',
      [types.Uuid.fromString(documentId), summary, new Date()],
      { prepare: true }
    );

    await analytics.onSummaryCreated(req.userId, 'Generated a summary');
    return res.json({ documentId, summary });
  } catch (err) {
    console.error('[summarizeDocument]', err);
    return res.status(500).json({ error: 'Failed to summarize document' });
  }
}

// INDEXING NOW — every document whose retrieval index is being built (survives a page reload)
async function listIndexing(req, res) {
  return res.json({ retrievalEnabled: retrieval.enabled, items: retrieval.activeIndexing() });
}

// INDEX STATUS — is this document searchable yet?
async function getIndexStatus(req, res) {
  const { documentId } = req.params;
  return res.json({ documentId, retrievalEnabled: retrieval.enabled, ...retrieval.getIndexStatus(documentId) });
}

// LIVE COMPARISON — index this document three ways on the sidecar and time each
async function startCompare(req, res) {
  try {
    const job = await retrieval.startCompare(req.params.documentId, req.body?.maxChunks);
    return res.status(202).json(job);
  } catch (err) {
    console.error('[startCompare]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}

async function compareStatus(req, res) {
  try {
    return res.json(await retrieval.compareStatus(req.params.jobId));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}

// QUALITY, live: one question through the three indexes of a finished comparison
async function compareSearch(req, res) {
  try {
    const query = (req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    return res.json(await retrieval.compareSearch(req.params.jobId, query, 3));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}

// QUALITY, measured: the LLM writes one question for each of N random chunks, then every
// index is asked each question and scored on whether it returns the chunk it came from.
async function compareSelfTest(req, res) {
  try {
    if (!llm.hasRealProvider) {
      return res.status(400).json({
        error: 'The self-test needs an LLM to write its questions. Set LLM_PROVIDER and LLM_API_KEY in the backend .env and restart.',
      });
    }
    const n = Math.max(5, Math.min(40, parseInt(req.body?.questions, 10) || 20));
    const { items: sample } = await retrieval.compareSample(req.params.jobId, n);

    // write the questions, a few at a time
    const items = [];
    let failed = 0;
    for (let i = 0; i < sample.length; i += 4) {
      const part = await Promise.all(
        sample.slice(i, i + 4).map(async (s, j) => {
          // half the questions are about the passage in general, half about one detail inside it;
          // the kind is fixed by position before any index is asked, so it cannot favour one
          const kind = (i + j) % 2 === 0 ? 'detail' : 'general';
          try {
            const question = await llm.questionForPassage(s.text, kind);
            return question && question.length > 8 ? { chunk: s.chunk, question, kind } : null;
          } catch {
            return null;
          }
        })
      );
      part.forEach((p) => (p ? items.push(p) : (failed += 1)));
    }
    if (!items.length) {
      return res.status(502).json({ error: 'The LLM did not return any usable questions. Check the provider settings.' });
    }
    const result = await retrieval.compareSelfTest(
      req.params.jobId,
      items.map(({ chunk, question }) => ({ chunk, question }))
    );
    // label each answered question with its kind and total the scores per kind
    const kindOf = new Map(items.map((it) => [`${it.chunk}|${it.question}`, it.kind]));
    const rows = (result.items || []).map((r) => ({ ...r, kind: kindOf.get(`${r.chunk}|${r.question}`) || 'general' }));
    const LABELS = { detail: 'Detail questions', general: 'General questions' };
    const groups = ['detail', 'general']
      .map((kind) => {
        const mine = rows.filter((r) => r.kind === kind);
        return {
          kind,
          label: LABELS[kind],
          questions: mine.length,
          systems: (result.systems || []).map((s) => ({
            id: s.id,
            name: s.name,
            foundFirst: mine.filter((r) => r.rank && r.rank[s.id] === 1).length,
            foundTop5: mine.filter((r) => r.rank && r.rank[s.id]).length,
          })),
        };
      })
      .filter((g) => g.questions > 0);
    return res.json({ ...result, items: rows, groups, questionsRequested: sample.length, questionsFailed: failed });
  } catch (err) {
    console.error('[compareSelfTest]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}

async function compareClose(req, res) {
  return res.json(await retrieval.compareClose(req.params.jobId));
}

function rowToDoc(r) {
  return {
    userId: r.user_id.toString(),
    uploadedAt: r.uploaded_at,
    documentId: r.document_id.toString(),
    title: r.title,
    subject: r.subject,
    pageCount: r.page_count,
  };
}

module.exports = {
  createDocument,
  uploadPdf,
  listDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  summarizeDocument,
  getIndexStatus,
  listIndexing,
  startCompare,
  compareStatus,
  compareSearch,
  compareSelfTest,
  compareClose,
};
