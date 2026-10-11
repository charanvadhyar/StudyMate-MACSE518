import React, { useEffect, useState } from 'react';
import { PageHeader } from '../layout/AppShell';
import { listDocuments, evaluateAnswer, listEvaluations } from '../api/endpoints';
import { errMsg } from '../api/client';
import { Button, Field, inputCls, Loading, ErrorBanner, EmptyState, scoreBand, Sources } from '../components/ui';

function Band({ score, max }) {
  const pct = max ? Math.round((score / max) * 100) : 0;
  const band = scoreBand(pct);
  const cls = { good: 'text-good bg-good/10 border-good/30', warn: 'text-warn bg-warn/10 border-warn/30', bad: 'text-bad bg-bad/10 border-bad/30' }[band];
  const label = { good: 'Strong', warn: 'Partial', bad: 'Needs work' }[band];
  return (
    <span className={`inline-flex items-baseline gap-2 px-3 py-1 rounded-md border ${cls}`}>
      <span className="font-heading text-xl">{score}/{max}</span>
      <span className="text-xs">{label}</span>
    </span>
  );
}

export default function Evaluator() {
  const [docs, setDocs] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [docId, setDocId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [maxScore, setMaxScore] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {score,maxScore,feedback,aiGraded}
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [d, h] = await Promise.all([listDocuments(), listEvaluations()]);
      setDocs(d);
      setHistory(h);
    } catch (err) {
      setError(errMsg(err, 'Could not load evaluator'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    setError('');
    if (!question.trim() || !answer.trim()) return setError('Question and answer are required');
    setBusy(true);
    setResult(null);
    try {
      const res = await evaluateAnswer({
        documentId: docId || undefined,
        question: question.trim(),
        studentAnswer: answer.trim(),
        maxScore: Number(maxScore),
      });
      setResult(res);
      setHistory(await listEvaluations());
    } catch (err) {
      setError(errMsg(err, 'Evaluation failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="AI Evaluator" subtitle="Get a free-text answer graded against your notes." />
      <div className="px-6 md:px-8 pb-10">
        <ErrorBanner message={error} onRetry={load} />
        {loading ? (
          <Loading label="Loading…" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
            {/* form + result */}
            <div className="flex flex-col gap-6">
              <div className="bg-surface rounded-lg border border-divider p-5 flex flex-col gap-4">
                <h2 className="font-heading text-xl">Grade an answer</h2>
                <Field label="Document (optional — grounds the grading)">
                  <select className={inputCls} value={docId} onChange={(e) => setDocId(e.target.value)}>
                    <option value="">— None —</option>
                    {docs.map((d) => (
                      <option key={d.documentId} value={d.documentId}>{d.title}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Question">
                  <input className={inputCls} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Explain the four conditions for deadlock." />
                </Field>
                <Field label="Your answer">
                  <textarea className={`${inputCls} min-h-[140px]`} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write your answer in full sentences…" />
                </Field>
                <Field label="Out of">
                  <input type="number" min={1} max={100} className={inputCls} value={maxScore} onChange={(e) => setMaxScore(e.target.value)} />
                </Field>
                <Button onClick={submit} busy={busy} disabled={busy}>
                  {busy ? 'Evaluating your answer…' : 'Evaluate'}
                </Button>
              </div>

              {result && (
                <div className="bg-surface rounded-lg border border-divider p-6 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-heading text-xl">Result</h3>
                    <Band score={result.score} max={result.maxScore} />
                  </div>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{result.feedback}</p>
                  <Sources retrieval={result.retrieval} />
                  {!result.aiGraded && (
                    <p className="text-xs text-n-500 border-t border-divider pt-2">
                      Running in fallback mode (keyword-overlap grading). Set an LLM provider on the backend for semantic AI grading.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* history */}
            <aside className="bg-surface rounded-lg border border-divider p-5 h-fit">
              <h2 className="font-heading text-xl mb-3">Past evaluations</h2>
              {history.length === 0 ? (
                <EmptyState title="No evaluations yet" />
              ) : (
                <ul className="flex flex-col gap-3">
                  {history.slice(0, 15).map((e) => {
                    const isOpen = expanded === e.evaluationId;
                    return (
                      <li key={e.evaluationId} className="border-b border-divider/60 pb-3">
                        <button className="w-full text-left" onClick={() => setExpanded(isOpen ? null : e.evaluationId)}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium line-clamp-1">{e.question}</span>
                            <span className="text-sm shrink-0">{e.score}/{e.maxScore}</span>
                          </div>
                          <div className="text-xs text-n-500">{new Date(e.evaluatedAt).toLocaleDateString()}</div>
                        </button>
                        {isOpen && <p className="text-sm text-n-700 mt-2 whitespace-pre-wrap">{e.feedback}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>
          </div>
        )}
      </div>
    </>
  );
}
