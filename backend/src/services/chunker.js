/**
 * chunker.js — split document text into retrieval-sized chunks.
 *
 * Chunks are built from whole paragraphs and sentences (never cut mid-word), packed up
 * to about `targetWords` words. That size fits the retrieval model's input limit and is
 * small enough that a handful of chunks makes a focused context for the LLM.
 */
const SENTENCE_END = /(?<=[.!?])["')\]]*\s+(?=["'(\[]?[A-Z0-9])/;

function words(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

function splitLong(paragraph, maxWords) {
  if (words(paragraph) <= maxWords) return [paragraph];
  const out = [];
  let cur = [];
  let n = 0;
  for (let sentence of paragraph.split(SENTENCE_END)) {
    let w = words(sentence);
    if (cur.length && n + w > maxWords) {
      out.push(cur.join(' '));
      cur = [];
      n = 0;
    }
    while (w > maxWords) {
      // one enormous sentence (or text with no punctuation): cut by words
      const parts = sentence.split(/\s+/);
      out.push(parts.slice(0, maxWords).join(' '));
      sentence = parts.slice(maxWords).join(' ');
      w = words(sentence);
    }
    if (sentence) {
      cur.push(sentence);
      n += w;
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

/**
 * @param {string} text
 * @param {{targetWords?: number, maxWords?: number}} [opts]
 * @returns {string[]} chunks in reading order
 */
function chunkText(text, opts = {}) {
  const targetWords = opts.targetWords || 160;
  const maxWords = opts.maxWords || 200;
  const paragraphs = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  let cur = [];
  let n = 0;
  for (const paragraph of paragraphs) {
    for (const piece of splitLong(paragraph, maxWords)) {
      const w = words(piece);
      if (cur.length && n + w > targetWords) {
        chunks.push(cur.join('\n\n'));
        cur = [];
        n = 0;
      }
      cur.push(piece);
      n += w;
    }
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

module.exports = { chunkText };
