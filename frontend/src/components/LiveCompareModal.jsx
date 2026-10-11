import React, { useEffect, useRef, useState } from 'react';
import { Modal, Button, Spinner, ErrorBanner, inputCls } from './ui';
import { Metric } from './BenchmarkModal';
import { startCompare, getCompare, compareSearch, compareSelfTest, closeCompare } from '../api/endpoints';
import { errMsg } from '../api/client';

const fmtBytes = (b) =>
  b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`;
const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);

const STATE_LABEL = { pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed' };

function SystemCard({ s, ours }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const running = s.state === 'running';
  return (
    <li className={`rounded-lg border p-3 flex flex-col gap-2 ${ours ? 'border-accent bg-accent/5' : 'border-divider bg-n-100'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-heading text-lg leading-tight">
          {s.name}
          {ours && <span className="ml-1 text-[10px] text-accent align-middle">this app</span>}
        </div>
        <span className={`text-xs shrink-0 flex items-center gap-1 ${s.state === 'failed' ? 'text-bad' : s.state === 'done' ? 'text-good' : 'text-n-600'}`}>
          {running && <Spinner />}
          {STATE_LABEL[s.state] || s.state}
        </span>
      </div>
      <p className="text-xs text-n-600 leading-snug">{s.how}</p>

      <div
        className="h-2 rounded-sm bg-ink/5 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={s.total}
        aria-valuenow={s.done}
        aria-label={`${s.name} progress`}
      >
        <div className={`h-full ${ours ? 'bg-accent' : 'bg-n-400'} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-n-600 tabular-nums">{s.done} / {s.total} chunks</div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt className="text-n-600">Upload speed</dt>
        <dd className="text-right tabular-nums">{s.chunks_per_s ? `${s.chunks_per_s.toFixed(1)} chunks/s` : '–'}</dd>
        <dt className="text-n-600">Time so far</dt>
        <dd className="text-right tabular-nums">{s.seconds ? fmtSecs(s.seconds) : '–'}</dd>
        <dt className="text-n-600 pl-3 text-xs">encoding</dt>
        <dd className="text-right tabular-nums text-xs text-n-600">{s.encode_s ? fmtSecs(s.encode_s) : '–'}</dd>
        <dt className="text-n-600 pl-3 text-xs">writing to Cassandra</dt>
        <dd className="text-right tabular-nums text-xs text-n-600">{s.write_s ? fmtSecs(s.write_s) : '–'}</dd>
        <dt className="text-n-600">Memory footprint</dt>
        <dd className="text-right tabular-nums">{s.bytes ? fmtBytes(s.bytes) : '–'}</dd>
        <dt className="text-n-600 pl-3 text-xs">per chunk</dt>
        <dd className="text-right tabular-nums text-xs text-n-600">{s.bytes_per_chunk ? fmtBytes(s.bytes_per_chunk) : '–'}</dd>
        <dt className="text-n-600 pl-3 text-xs">rows stored</dt>
        <dd className="text-right tabular-nums text-xs text-n-600">{s.vectors ? s.vectors.toLocaleString() : '–'}</dd>
      </dl>
      {s.error && <p className="text-xs text-bad">{s.error}</p>}
    </li>
  );
}

/**
 * Quality of the three freshly built indexes, two ways:
 *   - ask any question and read each system's top passages side by side;
 *   - a self-test where the LLM writes one question per sampled chunk and each index is
 *     scored on whether it returns the chunk the question was written for.
 */
function Quality({ jobId }) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [showItems, setShowItems] = useState(false);
  const [error, setError] = useState('');

  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError('');
    try {
      setAnswer(await compareSearch(jobId, q));
    } catch (err) {
      setError(errMsg(err, 'Could not run the question'));
    } finally {
      setAsking(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setError('');
    setTest(null);
    try {
      setTest(await compareSelfTest(jobId, 20));
    } catch (err) {
      setError(errMsg(err, 'The self-test failed'));
    } finally {
      setTesting(false);
    }
  };

  // a passage only one system returned is the interesting one to read
  const countOf = (chunk) => (answer ? answer.systems.filter((s) => s.results.some((r) => r.chunk === chunk)).length : 0);
  const testSystems = test ? test.systems.map((s) => ({ ...s, isOurs: s.id === 'smdb' })) : [];
  const perQuestion = test && test.questions ? 100 / test.questions : 0;

  return (
    <section className="border-t border-divider pt-4 flex flex-col gap-4">
      <div>
        <h4 className="font-heading text-xl">Quality</h4>
        <p className="text-xs text-n-600">
          Size and speed are half the picture. These two checks run against the three indexes just built.
        </p>
      </div>
      <ErrorBanner message={error} />

      {/* 1. ask a question */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">Ask all three the same question</div>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder="A question this document should answer…"
            aria-label="Question for all three indexes"
          />
          <Button onClick={ask} busy={asking} disabled={asking || !question.trim()}>Ask</Button>
        </div>
        {answer && (
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {answer.systems.map((s) => (
              <li key={s.id} className={`rounded-lg border p-3 ${s.id === 'smdb' ? 'border-accent bg-accent/5' : 'border-divider bg-n-100'}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-heading text-base leading-tight">{s.name}</span>
                  <span className="text-xs text-n-600 tabular-nums shrink-0">{Math.round(s.ms)} ms</span>
                </div>
                {s.results.length === 0 ? (
                  <p className="text-xs text-n-600 mt-2">No passages returned.</p>
                ) : (
                  <ol className="mt-2 flex flex-col gap-2">
                    {s.results.map((r, i) => (
                      <li key={r.chunk} className="text-xs leading-snug">
                        <div className="text-n-500">
                          {i + 1}. Chunk {r.chunk + 1}
                          {countOf(r.chunk) === 1 && <span className="ml-1 text-accent">· only here</span>}
                          {countOf(r.chunk) === 3 && <span className="ml-1">· all three</span>}
                        </div>
                        <div className="text-n-700">{r.preview}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2. self-test */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-medium">Self-test: can each index find the passage a question came from?</div>
            <p className="text-xs text-n-600">
              The LLM writes one question for each of 20 random chunks, in its own words: half about the chunk in
              general, half about one specific detail inside it. Each index answers every question. Takes about a
              minute.
            </p>
          </div>
          <Button variant="ghost" onClick={runTest} busy={testing} disabled={testing}>
            {testing ? 'Writing and asking…' : test ? 'Run again' : 'Run self-test'}
          </Button>
        </div>
        {test && (
          <>
            <Metric
              title="Right passage ranked first"
              hint={`Out of ${test.questions} questions. One question is worth ${perQuestion.toFixed(0)} points, so small gaps mean little.`}
              systems={testSystems}
              value={(s) => (typeof s.top1 === 'number' ? s.top1 * 100 : null)}
              format={(v) => `${v.toFixed(0)}%`}
              scaleMax={100}
              better="higher"
            />
            <Metric
              title="Right passage in the top 5"
              hint="The top 5 is what the answer is written from."
              systems={testSystems}
              value={(s) => (typeof s.top5 === 'number' ? s.top5 * 100 : null)}
              format={(v) => `${v.toFixed(0)}%`}
              scaleMax={100}
              better="higher"
            />
            {test.groups && test.groups.length > 1 && (
              <div className="overflow-x-auto">
                <div className="text-sm font-medium">By kind of question</div>
                <p className="text-xs text-n-600 mb-1">
                  Detail questions ask about one point inside a passage, not its main subject. Each cell is: ranked
                  first / in the top 5, out of the questions of that kind.
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-n-600 border-b border-divider">
                      <th className="py-1 pr-2 font-normal">Kind</th>
                      {test.groups[0].systems.map((s) => (
                        <th key={s.id} className="py-1 px-2 font-normal text-right whitespace-nowrap">{s.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {test.groups.map((g) => (
                      <tr key={g.kind} className="border-b border-divider/50">
                        <td className="py-1 pr-2">{g.label} ({g.questions})</td>
                        {g.systems.map((s) => (
                          <td key={s.id} className={`py-1 px-2 text-right tabular-nums ${s.id === 'smdb' ? 'font-medium' : ''}`}>
                            {s.foundFirst} / {s.foundTop5}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {test.questionsFailed > 0 && (
              <p className="text-xs text-n-600">{test.questionsFailed} question(s) could not be written and were left out.</p>
            )}
            <div>
              <button
                type="button"
                className="text-xs text-n-600 hover:text-accent underline decoration-dotted underline-offset-2"
                aria-expanded={showItems}
                onClick={() => setShowItems((v) => !v)}
              >
                {showItems ? 'Hide' : 'Show'} the questions and where each index ranked the right passage
              </button>
              {showItems && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-n-600 border-b border-divider">
                        <th className="py-1 pr-2 font-normal">Question</th>
                        {test.systems.map((s) => (
                          <th key={s.id} className="py-1 px-2 font-normal text-right whitespace-nowrap">{s.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {test.items.map((it, i) => (
                        <tr key={i} className="border-b border-divider/50 align-top">
                          <td className="py-1 pr-2">
                            {it.kind === 'detail' && <span className="text-n-600">[detail] </span>}
                            {it.question}
                          </td>
                          {test.systems.map((s) => (
                            <td key={s.id} className={`py-1 px-2 text-right tabular-nums ${it.rank[s.id] === 1 ? 'text-good' : it.rank[s.id] ? '' : 'text-bad'}`}>
                              {it.rank[s.id] ? `#${it.rank[s.id]}` : 'missed'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Indexes one document three ways on the server, live, and shows upload speed and memory
 * footprint for each as they run: Cassandra's own vector search (one vector per chunk), the
 * ColBERT Live! design, and this app's index.
 */
export default function LiveCompareModal({ open, doc, onClose, onShowBenchmark }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const runId = useRef(0);
  const liveJob = useRef(null); // id of the comparison whose data is still on the server
  const release = () => {
    if (liveJob.current) closeCompare(liveJob.current);
    liveJob.current = null;
  };

  const run = async () => {
    if (!doc) return;
    const mine = ++runId.current;
    release();
    setJob(null);
    setError('');
    setStarting(true);
    try {
      let j = await startCompare(doc.documentId);
      if (mine !== runId.current) { closeCompare(j.job_id); return; }
      liveJob.current = j.job_id;
      setJob(j);
      setStarting(false);
      while (j.state === 'running') {
        await new Promise((r) => setTimeout(r, 600));
        if (mine !== runId.current) return; // modal closed or restarted
        j = await getCompare(j.job_id);
        if (mine !== runId.current) return;
        setJob(j);
      }
      if (j.state === 'failed') setError(j.error || 'The comparison failed');
    } catch (err) {
      if (mine === runId.current) setError(errMsg(err, 'Could not run the comparison'));
    } finally {
      if (mine === runId.current) setStarting(false);
    }
  };

  useEffect(() => {
    if (open && doc) run();
    return () => { runId.current += 1; release(); }; // stop polling and drop the comparison data
  }, [open, doc?.documentId]);

  const systems = job?.systems || [];
  const done = job?.state === 'done';
  const ours = systems.find((s) => s.id === 'smdb');
  const live = systems.find((s) => s.id === 'live');
  const single = systems.find((s) => s.id === 'single');
  // the bar charts read the same field names as the benchmark modal
  const asMetric = systems.map((s) => ({ ...s, isOurs: s.id === 'smdb' }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={`Live indexing comparison${doc ? ` — ${doc.title}` : ''}`}
      footer={
        <>
          {onShowBenchmark && <Button variant="ghost" onClick={onShowBenchmark}>Full-book benchmark</Button>}
          <Button variant="ghost" onClick={run} disabled={starting || job?.state === 'running'}>Run again</Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed">
          This document is being indexed three ways right now, one after another, on your server.
          Every figure is measured as it happens.
          {job?.truncated_from && (
            <> Only the first {job.total} of its {job.truncated_from} chunks are used, to keep the run short.</>
          )}
        </p>

        <ErrorBanner message={error} onRetry={run} />
        {error && /Cassandra 5|comparison store unavailable/i.test(error) && (
          <p className="text-xs text-n-600 -mt-3">
            The comparison writes to a separate Cassandra 5.0 (port 9044), because the built-in vector index needs
            version 5. Start it from the StudyMateDb folder with{' '}
            <code className="bg-ink/5 px-1 rounded-sm">docker compose --profile jdk21 up -d cassandra-jdk21</code> and run again.
          </p>
        )}

        {starting && !job && (
          <div className="flex items-center gap-2 text-sm text-n-600"><Spinner /> Starting…</div>
        )}

        {systems.length > 0 && (
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {systems.map((s) => <SystemCard key={s.id} s={s} ours={s.id === 'smdb'} />)}
          </ul>
        )}

        {done && ours && live && single && (
          <>
            <p className="text-sm leading-relaxed border-l-2 border-accent pl-3">
              For this document, this app's index took{' '}
              <span className="font-medium">{(live.bytes / ours.bytes).toFixed(1)}× less space</span> than the
              ColBERT Live! design and was written{' '}
              <span className="font-medium">{(ours.write_chunks_per_s / live.write_chunks_per_s).toFixed(1)}× faster</span>.
              One vector per chunk is the smallest of the three
              ({(ours.bytes / single.bytes).toFixed(1)}× smaller than this index) but answers from a single
              summary vector per chunk.
            </p>
            <Metric
              title="Memory footprint"
              hint="Data written for this document: vectors or codes plus their keys."
              systems={asMetric}
              value={(s) => s.bytes}
              format={fmtBytes}
              better="lower"
            />
            <Metric
              title="Upload speed"
              hint="Chunks per second from text to stored index: encoding plus writing."
              systems={asMetric}
              value={(s) => s.chunks_per_s}
              format={(v) => `${v.toFixed(1)} chunks/s`}
              better="higher"
            />
            <Metric
              title="Writing to Cassandra only"
              hint="Chunks per second for the database writes alone, once the chunks are encoded."
              systems={asMetric}
              value={(s) => s.write_chunks_per_s}
              format={(v) => `${v.toFixed(1)} chunks/s`}
              better="higher"
            />
          </>
        )}

        {done && job?.searchable !== false && <Quality key={job.job_id} jobId={job.job_id} />}

        <p className="border-t border-divider pt-3 text-xs text-n-600 leading-relaxed">
          Memory footprint here is the data handed to the database. Cassandra adds its own overhead on disk,
          most of all for the built-in vector index, so on-disk gaps are larger; the full-book benchmark has
          those figures. The three runs happen in sequence so they do not compete for the processor, and the
          comparison data is removed when this window closes. The ColBERT Live! column is a re-implementation of the
          published design.
        </p>
      </div>
    </Modal>
  );
}
