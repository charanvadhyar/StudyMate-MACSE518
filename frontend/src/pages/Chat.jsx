import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PageHeader } from '../layout/AppShell';
import {
  listSessions,
  createSession,
  getMessages,
  sendMessage,
  listDocuments,
} from '../api/endpoints';
import { errMsg } from '../api/client';
import { Button, Field, inputCls, Loading, ErrorBanner, EmptyState, Modal, TypingDots, Sources } from '../components/ui';

export default function Chat() {
  const location = useLocation();
  const [sessions, setSessions] = useState([]);
  const [docs, setDocs] = useState([]);
  const [active, setActive] = useState(null); // session object
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDoc, setNewDoc] = useState('');
  const [creating, setCreating] = useState(false);

  const threadRef = useRef(null);

  // map documentId -> title for the header (sessions only store the id)
  const docTitle = (id) => docs.find((d) => d.documentId === id)?.title || 'No document';

  const loadSessions = async () => {
    setLoading(true);
    setError('');
    try {
      const [s, d] = await Promise.all([listSessions(), listDocuments()]);
      setSessions(s);
      setDocs(d);
      return { s, d };
    } catch (err) {
      setError(errMsg(err, 'Could not load chat'));
      return { s: [], d: [] };
    } finally {
      setLoading(false);
    }
  };

  const openSession = async (session) => {
    setActive(session);
    setMessages([]);
    try {
      setMessages(await getMessages(session.sessionId));
    } catch (err) {
      setError(errMsg(err, 'Could not load messages'));
    }
  };

  useEffect(() => {
    (async () => {
      await loadSessions();
      // if navigated here from a document's "Ask" button, prefill the new-session modal
      if (location.state?.documentId) {
        setNewDoc(location.state.documentId);
        setNewTitle(location.state.title ? `Chat — ${location.state.title}` : '');
        setNewOpen(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, thinking]);

  const createNew = async () => {
    setCreating(true);
    try {
      const res = await createSession({ documentId: newDoc || undefined, title: newTitle || 'New session' });
      setNewOpen(false);
      setNewTitle(''); setNewDoc('');
      const { s } = await loadSessions();
      const created = s.find((x) => x.sessionId === res.sessionId) || {
        sessionId: res.sessionId, title: res.title, documentId: newDoc, startedAt: res.startedAt,
      };
      openSession(created);
    } catch (err) {
      setError(errMsg(err, 'Could not create session'));
    } finally {
      setCreating(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active) return;
    setInput('');
    setMessages((m) => [...m, { sender: 'user', text, sentAt: new Date().toISOString() }]);
    setThinking(true);
    try {
      const res = await sendMessage(active.sessionId, { text, documentId: active.documentId || undefined });
      setMessages((m) => [...m, { sender: 'bot', text: res.answer, retrieval: res.retrieval, sentAt: new Date().toISOString() }]);
    } catch (err) {
      setMessages((m) => [...m, { sender: 'bot', text: `⚠ ${errMsg(err, 'No answer')}`, sentAt: new Date().toISOString() }]);
    } finally {
      setThinking(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Chat"
        subtitle="Ask questions grounded in your own notes."
        action={<Button onClick={() => setNewOpen(true)}>New session</Button>}
      />
      <div className="px-6 md:px-8 pb-6">
        <ErrorBanner message={error} onRetry={loadSessions} />
      </div>

      {loading ? (
        <Loading label="Loading chat…" />
      ) : (
        <div className="px-6 md:px-8 pb-10 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-160px)]">
          {/* sessions list */}
          <aside className="bg-surface rounded-lg border border-divider overflow-auto sm-scroll">
            {sessions.length === 0 ? (
              <div className="p-4 text-sm text-n-600">No sessions yet.</div>
            ) : (
              <ul>
                {sessions.map((s) => (
                  <li key={s.sessionId}>
                    <button
                      onClick={() => openSession(s)}
                      className={`w-full text-left px-4 py-3 border-b border-divider/60 ${
                        active?.sessionId === s.sessionId ? 'bg-accent/10' : 'hover:bg-ink/5'
                      }`}
                    >
                      <div className="text-sm font-medium truncate">{s.title}</div>
                      <div className="text-xs text-n-500 truncate">{docTitle(s.documentId)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* thread */}
          <section className="bg-surface rounded-lg border border-divider flex flex-col overflow-hidden">
            {!active ? (
              <EmptyState title="Pick a session" hint="Or start a new one to ask about a document." />
            ) : (
              <>
                <div className="px-4 py-3 border-b border-divider">
                  <div className="font-heading text-lg">{active.title}</div>
                  <div className="text-xs text-n-500">{docTitle(active.documentId)}</div>
                </div>
                <div ref={threadRef} className="flex-1 overflow-auto sm-scroll p-4 flex flex-col gap-3">
                  {messages.length === 0 && !thinking ? (
                    <EmptyState title="Ask a question about your notes" />
                  ) : (
                    messages.map((m, i) => (
                      <div key={i} className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                        m.sender === 'user'
                          ? 'self-end bg-accent text-white'
                          : 'self-start bg-white border border-divider'
                      }`}>
                        <div className="whitespace-pre-wrap">{m.text}</div>
                        {m.sender === 'bot' && (
                          <Sources retrieval={m.retrieval} className="mt-2 pt-2 border-t border-divider/60" />
                        )}
                      </div>
                    ))
                  )}
                  {thinking && (
                    <div className="self-start bg-white border border-divider px-3 py-2 rounded-lg">
                      <TypingDots />
                    </div>
                  )}
                </div>
                <div className="p-3 border-t border-divider flex gap-2">
                  <input
                    className={inputCls}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send()}
                    placeholder="Ask something…"
                  />
                  <Button onClick={send} disabled={!input.trim() || thinking}>Send</Button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* new session modal */}
      <Modal
        open={newOpen}
        title="New chat session"
        onClose={() => setNewOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={createNew} busy={creating} disabled={creating}>Start</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Title">
            <input className={inputCls} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Deadlocks — revision" />
          </Field>
          <Field label="Document (grounds the answers)">
            <select className={inputCls} value={newDoc} onChange={(e) => setNewDoc(e.target.value)}>
              <option value="">— None —</option>
              {docs.map((d) => (
                <option key={d.documentId} value={d.documentId}>{d.title}</option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>
    </>
  );
}
