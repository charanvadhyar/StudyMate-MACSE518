import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../layout/AppShell';
import {
  listDocuments,
  createDocument,
  uploadPdf,
  updateDocument,
  deleteDocument,
  summarizeDocument,
  getIndexStatus,
  listIndexing,
} from '../api/endpoints';
import { errMsg } from '../api/client';
import { Button, Field, inputCls, Loading, ErrorBanner, EmptyState, Modal, Spinner } from '../components/ui';
import BenchmarkModal from '../components/BenchmarkModal';
import LiveCompareModal from '../components/LiveCompareModal';

// Fallback only: extract text from a PDF in the browser using pdfjs loaded from CDN.
// The normal path sends the file to the server, which keeps chapters, sections and pages;
// this is used when the server cannot take the file (older backend).
async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.body.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text.trim();
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString() : '';
}

export default function Documents() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // upload modal
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mode, setMode] = useState('pdf'); // 'pdf' | 'paste'
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [file, setFile] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState('');

  // edit / delete / summarize state keyed by documentId
  const [editing, setEditing] = useState(null); // {documentId, uploadedAt, title, subject}
  const [deleting, setDeleting] = useState(null);
  const [summary, setSummary] = useState(null); // {title, text}
  const [busyId, setBusyId] = useState(null);
  const [benchOpen, setBenchOpen] = useState(false);
  const [comparing, setComparing] = useState(null); // document being compared live

  // retrieval indexing progress for documents uploaded in this session: documentId -> status
  const [indexing, setIndexing] = useState({});
  const polling = React.useRef(new Set());
  const pollIndex = async (documentId) => {
    if (polling.current.has(documentId)) return; // one loop per document
    polling.current.add(documentId);
    try {
      // no time limit: a whole textbook can take many minutes, and the note must follow it to the end
      for (;;) {
        let st;
        try {
          st = await getIndexStatus(documentId);
        } catch {
          return; // older backend without the endpoint, or signed out: just stop
        }
        if (!st.retrievalEnabled || st.state === 'unknown') return;
        setIndexing((m) => ({ ...m, [documentId]: st }));
        if (st.state !== 'indexing') {
          // keep "ready" visible briefly, then clear the note
          if (st.state === 'ready') {
            setTimeout(() => setIndexing((m) => { const n = { ...m }; delete n[documentId]; return n; }), 6000);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      polling.current.delete(documentId);
    }
  };

  // pick up indexing that is already running (page reloaded, or started in another tab)
  const resumeIndexing = async () => {
    try {
      const { items } = await listIndexing();
      (items || []).forEach((it) => {
        setIndexing((m) => ({ ...m, [it.documentId]: it }));
        if (it.state === 'indexing') pollIndex(it.documentId);
      });
    } catch {
      /* older backend: nothing to resume */
    }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setDocs(await listDocuments());
    } catch (err) {
      setError(errMsg(err, 'Could not load documents'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    resumeIndexing();
  }, []);

  const resetUpload = () => {
    setTitle(''); setSubject(''); setPasteText(''); setFile(null); setUploadErr(''); setMode('pdf');
  };

  const submitUpload = async () => {
    setUploadErr('');
    if (!title.trim()) return setUploadErr('Give the document a title');
    setUploadBusy(true);
    try {
      let created;
      if (mode === 'pdf') {
        if (!file) throw new Error('Choose a PDF file');
        try {
          created = await uploadPdf({ file, title: title.trim(), subject: subject.trim() || 'General' });
        } catch (err) {
          if (err?.response?.status !== 404) throw err; // 404 = backend without the upload route
          const text = await extractPdfText(file);
          if (!text) throw new Error('No text could be extracted from that PDF');
          created = await createDocument({ title: title.trim(), subject: subject.trim() || 'General', text });
        }
      } else {
        if (!pasteText.trim()) throw new Error('Paste some notes');
        created = await createDocument({ title: title.trim(), subject: subject.trim() || 'General', text: pasteText });
      }
      setUploadOpen(false);
      resetUpload();
      await load();
      if (created?.note) setError(created.note); // e.g. sections could not be kept for this PDF
      if (created?.retrieval === 'indexing') pollIndex(created.documentId);
    } catch (err) {
      setUploadErr(errMsg(err, 'Upload failed'));
    } finally {
      setUploadBusy(false);
    }
  };

  const saveEdit = async () => {
    try {
      await updateDocument(editing.documentId, {
        uploadedAt: editing.uploadedAt,
        title: editing.title,
        subject: editing.subject,
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(errMsg(err, 'Update failed'));
    }
  };

  const confirmDelete = async () => {
    try {
      await deleteDocument(deleting.documentId, deleting.uploadedAt);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(errMsg(err, 'Delete failed'));
    }
  };

  const runSummarize = async (doc) => {
    setBusyId(doc.documentId);
    setError('');
    try {
      const res = await summarizeDocument(doc.documentId);
      setSummary({ title: doc.title, text: res.summary });
    } catch (err) {
      setError(errMsg(err, 'Summarize failed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Upload notes, then summarize, ask, or quiz on them."
        action={<Button onClick={() => setUploadOpen(true)}>Upload</Button>}
      />
      <div className="px-6 md:px-8 pb-10">
        <ErrorBanner message={error} onRetry={load} />
        {loading ? (
          <Loading label="Loading documents…" />
        ) : docs.length === 0 ? (
          <EmptyState
            title="Upload your first document"
            hint="A PDF of your notes, or paste text directly."
            action={<Button onClick={() => setUploadOpen(true)}>Upload</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {docs.map((d) => (
              <div key={d.documentId} className="bg-surface rounded-lg border border-divider p-4 flex flex-col gap-3">
                <div>
                  <div className="font-heading text-lg leading-snug">{d.title}</div>
                  <div className="text-xs text-n-500 mt-0.5">
                    {d.subject} · {d.pageCount} chunk{d.pageCount === 1 ? '' : 's'} · {fmtDate(d.uploadedAt)}
                  </div>
                  {indexing[d.documentId] && (
                    <div className="text-xs mt-1 flex items-center gap-1.5" role="status">
                      {indexing[d.documentId].state === 'indexing' && (
                        <>
                          <Spinner />
                          <span className="text-n-600">
                            Preparing for search… {indexing[d.documentId].done}/{indexing[d.documentId].total} chunks.
                            You can already ask questions.
                          </span>
                        </>
                      )}
                      {indexing[d.documentId].state === 'ready' && (
                        <span className="text-good">Ready for focused answers.</span>
                      )}
                      {indexing[d.documentId].state === 'failed' && (
                        <span className="text-n-600">
                          Search index stopped at {indexing[d.documentId].done}/{indexing[d.documentId].total} chunks;
                          answers will use the whole document.
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-auto">
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => runSummarize(d)} disabled={busyId === d.documentId}>
                    {busyId === d.documentId ? <Spinner /> : null} Summarize
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => navigate('/chat', { state: { documentId: d.documentId, title: d.title } })}>
                    Ask
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => navigate('/quiz', { state: { documentId: d.documentId, title: d.title } })}>
                    Quiz
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setComparing(d)}>
                    Compare indexing
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setEditing({ ...d })}>
                    Edit
                  </Button>
                  <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => setDeleting(d)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload modal */}
      <Modal
        open={uploadOpen}
        title="Upload document"
        onClose={() => { setUploadOpen(false); resetUpload(); }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setUploadOpen(false); resetUpload(); }}>Cancel</Button>
            <Button onClick={submitUpload} busy={uploadBusy} disabled={uploadBusy}>Upload</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <ErrorBanner message={uploadErr} />
          <div className="flex gap-2">
            <button
              className={`px-3 py-1.5 rounded-md text-sm border ${mode === 'pdf' ? 'border-accent text-accent bg-accent/10' : 'border-divider text-n-600'}`}
              onClick={() => setMode('pdf')}
            >
              PDF file
            </button>
            <button
              className={`px-3 py-1.5 rounded-md text-sm border ${mode === 'paste' ? 'border-accent text-accent bg-accent/10' : 'border-divider text-n-600'}`}
              onClick={() => setMode('paste')}
            >
              Paste text
            </button>
          </div>
          <Field label="Title">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="OS Unit 4 — Memory Management" />
          </Field>
          <Field label="Subject">
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Operating Systems" />
          </Field>
          {mode === 'pdf' ? (
            <Field label="PDF file">
              <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-sm" />
              <p className="text-xs text-n-500 mt-1">
                The file is read on the server, keeping its chapters, sections and page numbers so answers can point to them.
              </p>
            </Field>
          ) : (
            <Field label="Notes">
              <textarea className={`${inputCls} min-h-[140px]`} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="Paste your notes…" />
            </Field>
          )}
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editing}
        title="Edit document"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <Field label="Title">
              <input className={inputCls} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </Field>
            <Field label="Subject">
              <input className={inputCls} value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={!!deleting}
        title="Delete document?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-sm">
          This permanently removes <span className="font-medium">{deleting?.title}</span> and its chunks and summary.
        </p>
      </Modal>

      {/* Live indexing comparison for one document, and the full-book benchmark behind it */}
      <LiveCompareModal
        open={!!comparing}
        doc={comparing}
        onClose={() => setComparing(null)}
        onShowBenchmark={() => setBenchOpen(true)}
      />
      <BenchmarkModal open={benchOpen} onClose={() => setBenchOpen(false)} />

      {/* Summary result */}
      <Modal open={!!summary} title={`Summary — ${summary?.title || ''}`} onClose={() => setSummary(null)}>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{summary?.text}</p>
      </Modal>
    </>
  );
}
