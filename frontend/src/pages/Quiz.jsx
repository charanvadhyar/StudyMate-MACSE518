import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PageHeader } from '../layout/AppShell';
import { listDocuments, generateQuiz, submitAttempt, listAttempts } from '../api/endpoints';
import { errMsg } from '../api/client';
import { Button, Field, inputCls, Loading, ErrorBanner, EmptyState, ScoreBadge, Spinner, Sources } from '../components/ui';

export default function Quiz() {
  const location = useLocation();
  const [docs, setDocs] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // setup
  const [docId, setDocId] = useState('');
  const [numQ, setNumQ] = useState(5);
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);

  // taking
  const [quiz, setQuiz] = useState(null); // {quizId, documentId, questions:[{index,question,options}]}
  const [answers, setAnswers] = useState({}); // index -> option text
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // {score,total}

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [d, a] = await Promise.all([listDocuments(), listAttempts()]);
      setDocs(d);
      setAttempts(a);
      if (location.state?.documentId) setDocId(location.state.documentId);
    } catch (err) {
      setError(errMsg(err, 'Could not load quiz data'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const generate = async () => {
    if (!docId) return setError('Choose a document first');
    setGenerating(true);
    setError('');
    setResult(null);
    try {
      const q = await generateQuiz(docId, { numQuestions: Number(numQ), topic: topic.trim() || undefined });
      setQuiz(q);
      setAnswers({});
    } catch (err) {
      setError(errMsg(err, 'Could not generate quiz'));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    if (!quiz) return;
    setSubmitting(true);
    setError('');
    try {
      // build an index-aligned array of selected option texts
      const arr = quiz.questions.map((q) => answers[q.index] ?? '');
      const res = await submitAttempt(quiz.documentId, quiz.quizId, { answers: arr });
      setResult(res);
      setAttempts(await listAttempts());
    } catch (err) {
      setError(errMsg(err, 'Could not submit quiz'));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setQuiz(null);
    setAnswers({});
    setResult(null);
  };

  return (
    <>
      <PageHeader title="Quiz" subtitle="Generate a quiz from a document and test yourself." />
      <div className="px-6 md:px-8 pb-10">
        <ErrorBanner message={error} onRetry={load} />

        {loading ? (
          <Loading label="Loading…" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
            {/* main column */}
            <div>
              {/* setup */}
              {!quiz && !result && (
                <div className="bg-surface rounded-lg border border-divider p-5 flex flex-col gap-4">
                  <h2 className="font-heading text-xl">New quiz</h2>
                  {docs.length === 0 ? (
                    <EmptyState title="No documents yet" hint="Upload a document first." />
                  ) : (
                    <>
                      <Field label="Document">
                        <select className={inputCls} value={docId} onChange={(e) => setDocId(e.target.value)}>
                          <option value="">— Choose —</option>
                          {docs.map((d) => (
                            <option key={d.documentId} value={d.documentId}>{d.title}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Questions">
                        <input type="number" min={1} max={15} className={inputCls} value={numQ} onChange={(e) => setNumQ(e.target.value)} />
                      </Field>
                      <Field label="Topic (optional)">
                        <input
                          className={inputCls}
                          value={topic}
                          onChange={(e) => setTopic(e.target.value)}
                          placeholder="e.g. normal forms and functional dependencies — leave empty for the whole document"
                        />
                      </Field>
                      <Button onClick={generate} busy={generating} disabled={generating}>
                        Generate quiz
                      </Button>
                    </>
                  )}
                </div>
              )}

              {/* generating */}
              {generating && !quiz && (
                <div className="flex items-center gap-2 text-sm text-n-600 mt-4">
                  <Spinner /> Generating questions…
                </div>
              )}

              {/* taking */}
              {quiz && !result && (
                <div className="bg-surface rounded-lg border border-divider p-5 flex flex-col gap-5">
                  <h2 className="font-heading text-xl">Answer the questions</h2>
                  {quiz.aiGenerated === false && (
                    <p role="status" className="text-sm px-3 py-2 rounded-md border border-warn/40 border-l-4 border-l-warn bg-warn/5">
                      These are placeholder questions, not ones written from your document.
                      {quiz.notice ? ` ${quiz.notice}` : ''}
                    </p>
                  )}
                  {quiz.aiGenerated !== false && quiz.source && (
                    <p className="text-xs text-n-600 -mt-3">
                      {quiz.source.mode === 'topic' && `Written from the ${quiz.source.chunksUsed} passages found for "${quiz.source.topic}". A specific topic finds better passages than a single word.`}
                      {quiz.source.mode === 'sampled' && `Written from ${quiz.source.chunksUsed} passages spread across the document (${quiz.source.chunksTotal} chunks in total). Generate again for a different selection.`}
                      {quiz.source.mode === 'whole-document' && 'Written from the whole document.'}
                    </p>
                  )}
                  {quiz.aiGenerated !== false && quiz.notice && (
                    <p role="status" className="text-sm px-3 py-2 rounded-md border border-divider bg-ink/5 -mt-2">{quiz.notice}</p>
                  )}
                  {quiz.source?.mode === 'topic' && quiz.source.passages?.length > 0 && (
                    <Sources retrieval={{ mode: 'retrieval', sources: quiz.source.passages }} className="-mt-2" />
                  )}
                  {quiz.questions.map((q) => (
                    <div key={q.index}>
                      <p className="text-sm font-medium mb-2">{q.index + 1}. {q.question}</p>
                      <div className="flex flex-col gap-1.5">
                        {q.options.map((opt, oi) => (
                          <label key={oi} className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm cursor-pointer ${
                            answers[q.index] === opt ? 'border-accent bg-accent/10' : 'border-divider hover:bg-ink/5'
                          }`}>
                            <input
                              type="radio"
                              name={`q${q.index}`}
                              checked={answers[q.index] === opt}
                              onChange={() => setAnswers({ ...answers, [q.index]: opt })}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Button onClick={submit} busy={submitting} disabled={submitting}>Submit</Button>
                    <Button variant="ghost" onClick={reset}>Cancel</Button>
                  </div>
                </div>
              )}

              {/* result */}
              {result && (
                <div className="bg-surface rounded-lg border border-divider p-6 flex flex-col items-start gap-4">
                  <h2 className="font-heading text-2xl">Your score</h2>
                  <ScoreBadge score={result.score} total={result.total} />
                  <Button onClick={reset}>Take another</Button>
                </div>
              )}
            </div>

            {/* history */}
            <aside className="bg-surface rounded-lg border border-divider p-5 h-fit">
              <h2 className="font-heading text-xl mb-3">Recent attempts</h2>
              {attempts.length === 0 ? (
                <p className="text-sm text-n-600">No attempts yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attempts.slice(0, 12).map((a, i) => (
                    <li key={i} className="flex items-center justify-between text-sm">
                      <span className="text-n-600">{new Date(a.attemptedAt).toLocaleDateString()}</span>
                      <ScoreBadge score={a.score} total={a.total} />
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        )}
      </div>
    </>
  );
}
