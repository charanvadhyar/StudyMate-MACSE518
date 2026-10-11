import React from 'react';
import { Modal } from './ui';
import data from '../data/benchmark.json';

const fmtBytes = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${(b / 1e3).toFixed(1)} KB`);

/**
 * One metric as three horizontal bars, one per system. Values are always printed, so the
 * bars never carry the meaning alone; a system without a measurement says so.
 */
export function Metric({ title, hint, systems, value, format, better, scaleMax }) {
  const measured = systems.map(value).filter((v) => typeof v === 'number');
  const max = scaleMax || Math.max(...measured, 0); // percentages pass scaleMax={100} so bars are not stretched
  const best = measured.length ? (better === 'lower' ? Math.min(...measured) : Math.max(...measured)) : null;
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-heading text-lg">{title}</h4>
        <span className="text-xs text-n-500">{better === 'lower' ? 'smaller is better' : 'larger is better'}</span>
      </div>
      {hint && <p className="text-xs text-n-600 mb-2">{hint}</p>}
      <ul className="flex flex-col gap-2">
        {systems.map((s) => {
          const v = value(s);
          const has = typeof v === 'number';
          const pct = has && max ? Math.max(2, Math.round((v / max) * 100)) : 0;
          return (
            <li key={s.id} className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-sm">
              <span className={`sm:truncate ${s.isOurs ? 'font-medium text-ink' : 'text-n-700'}`}>
                {s.name}
                {s.isOurs && <span className="ml-1 text-[10px] text-accent">this app</span>}
              </span>
              <span className="h-2.5 rounded-sm bg-ink/5 overflow-hidden" aria-hidden="true">
                {has && (
                  <span
                    className={`block h-full rounded-sm ${s.isOurs ? 'bg-accent' : 'bg-n-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                )}
              </span>
              <span className={`tabular-nums text-right min-w-[5.5rem] ${has ? '' : 'text-n-500 text-xs'}`}>
                {has ? format(v) : 'not measured'}
                {has && v === best && measured.length > 1 && (
                  <span className="sr-only"> (best)</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function BenchmarkModal({ open, onClose }) {
  const { systems, corpus, notes, environment, measuredOn } = data;
  const ours = systems.find((s) => s.isOurs);
  const live = systems.find((s) => s.id === 'colbert-live');
  const ratio = (a, b) => (a && b ? a / b : null);
  const diskRatio = ratio(live?.diskBytesPerChunk, ours?.diskBytesPerChunk);
  const writeRatio = ratio(ours?.writeChunksPerSec, live?.writeChunksPerSec);

  return (
    <Modal open={open} onClose={onClose} title="How your documents are indexed" size="xl">
      <div className="flex flex-col gap-6">
        <p className="text-sm leading-relaxed">
          Three ways to make a document searchable in Cassandra, measured on the same textbook
          ({corpus.pages} pages, {corpus.chunks.toLocaleString()} chunks).
          {diskRatio && writeRatio && (
            <>
              {' '}Against the ColBERT Live! design, this app's index takes{' '}
              <span className="font-medium">{diskRatio.toFixed(0)}× less disk</span> and stores chunks{' '}
              <span className="font-medium">{writeRatio.toFixed(1)}× faster</span>, for a few points of accuracy.
            </>
          )}
        </p>

        <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {systems.map((s) => (
            <li
              key={s.id}
              className={`rounded-lg border p-3 ${s.isOurs ? 'border-accent bg-accent/5' : 'border-divider bg-n-100'}`}
            >
              <div className="font-heading text-lg leading-tight">{s.name}</div>
              <p className="text-xs text-n-600 mt-1 leading-snug">{s.tagline}</p>
              <p className="text-xs text-n-700 mt-2 leading-snug">Stores {s.stores}.</p>
            </li>
          ))}
        </ul>

        <Metric
          title="Memory footprint"
          hint={`Disk used per chunk, index included. For the whole book: ${systems
            .filter((s) => s.diskBytesPerChunk)
            .map((s) => `${s.name} ${fmtBytes(s.diskBytesPerChunk * corpus.chunks)}`)
            .join(', ')}.`}
          systems={systems}
          value={(s) => s.diskBytesPerChunk}
          format={fmtBytes}
          better="lower"
        />
        <Metric
          title="Upload speed"
          hint="Chunks written to Cassandra per second, once they are encoded."
          systems={systems}
          value={(s) => s.writeChunksPerSec}
          format={(v) => `${v.toFixed(1)} chunks/s`}
          better="higher"
        />
        <Metric
          title="Time to find passages"
          hint="Median time per question, after the question is encoded."
          systems={systems}
          value={(s) => s.queryMs}
          format={(v) => `${Math.round(v)} ms`}
          better="lower"
        />
        <Metric
          title="Accuracy"
          hint={`Share of ${corpus.questions} review questions whose first result came from the right chapter.`}
          systems={systems}
          value={(s) => (typeof s.top1 === 'number' ? s.top1 * 100 : null)}
          format={(v) => `${v.toFixed(1)}%`}
          scaleMax={100}
          better="higher"
        />

        <div className="border-t border-divider pt-3 text-xs text-n-600 leading-relaxed">
          <p className="mb-1">
            Measured {measuredOn} on {environment}. Book: {corpus.title}.
          </p>
          <ul className="list-disc pl-4 flex flex-col gap-1">
            {systems
              .filter((s) => s.top1Note)
              .map((s) => (
                <li key={s.id}>{s.name} accuracy: {s.top1Note}.</li>
              ))}
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
