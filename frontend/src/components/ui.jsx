import React, { useState } from 'react';

export function Spinner({ className = '' }) {
  return <span className={`sm-spin ${className}`} aria-label="loading" />;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-2 text-sm text-n-600 py-10 justify-center">
      <Spinner /> {label}
    </div>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sm-dot" /> <span className="sm-dot" /> <span className="sm-dot" />
    </span>
  );
}

export function EmptyState({ title, hint, action }) {
  return (
    <div className="text-center py-12 px-4">
      <p className="font-heading text-xl text-ink">{title}</p>
      {hint && <p className="text-sm text-n-600 mt-1">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-bad/40 border-l-4 border-l-bad bg-bad/5 text-sm text-bad"
    >
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="underline shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}

// score band: green >=80%, amber >=50%, red below
export function scoreBand(pct) {
  if (pct >= 80) return 'good';
  if (pct >= 50) return 'warn';
  return 'bad';
}

export function ScoreBadge({ score, total }) {
  const pct = total ? Math.round((score / total) * 100) : 0;
  const band = scoreBand(pct);
  const cls = { good: 'text-good bg-good/10', warn: 'text-warn bg-warn/10', bad: 'text-bad bg-bad/10' }[band];
  return (
    <span className={`inline-flex items-baseline gap-1 px-2 py-0.5 rounded-md text-sm font-medium ${cls}`}>
      <span className="font-heading text-base">{score}</span>
      <span className="opacity-70">/ {total}</span>
      <span className="opacity-70 ml-1">({pct}%)</span>
    </span>
  );
}

export function StatCard({ label, value, note }) {
  return (
    <div className="bg-surface rounded-lg border border-divider p-4 shadow-sm">
      <div className="text-xs text-n-600">{label}</div>
      <div className="font-heading text-3xl mt-1 text-ink">{value}</div>
      {note && <div className="text-xs text-n-500 mt-1">{note}</div>}
    </div>
  );
}

export function Button({ children, variant = 'primary', className = '', busy, ...rest }) {
  const base = 'inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm transition disabled:opacity-50 disabled:cursor-not-allowed';
  const styles = {
    primary: 'bg-accent text-white hover:bg-accent-600',
    ghost: 'border border-divider text-ink hover:bg-ink/5',
    danger: 'border border-bad/40 text-bad hover:bg-bad/5',
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Modal({ open, title, onClose, children, footer, size = 'lg' }) {
  if (!open) return null;
  const width = size === 'xl' ? 'max-w-3xl' : 'max-w-lg';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/30" onClick={onClose}>
      <div
        className={`bg-surface rounded-lg border border-divider shadow-sm w-full ${width} max-h-[85vh] overflow-auto sm-scroll`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-divider">
          <h3 className="font-heading text-xl">{title}</h3>
          <button onClick={onClose} className="text-n-500 hover:text-ink text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-divider flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Where an answer came from. `retrieval` is what the backend returns with chat answers and
 * evaluations: { mode: 'retrieval'|'full-document'|'none', sources: [{chunkIndex, page, score, preview}] }.
 * Shows a one-line summary that expands into the passages used.
 */
export function Sources({ retrieval, className = '' }) {
  const [open, setOpen] = useState(false);
  if (!retrieval || retrieval.mode === 'none') return null;
  const sources = retrieval.sources || [];

  if (retrieval.mode !== 'retrieval' || sources.length === 0) {
    return (
      <div className={`text-xs text-n-500 ${className}`}>
        Used the whole document as context{retrieval.chunksUsed ? ` (${retrieval.chunksUsed} chunks)` : ''}.
      </div>
    );
  }
  return (
    <div className={`text-xs ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-n-600 hover:text-accent underline decoration-dotted underline-offset-2"
      >
        {open ? 'Hide' : 'Show'} the {sources.length} passage{sources.length === 1 ? '' : 's'} this is based on
      </button>
      {open && (
        <ol className="mt-2 flex flex-col gap-2">
          {sources.map((s, i) => (
            <li key={s.chunkIndex} className="border-l-2 border-mark bg-mark-soft/70 rounded-r-md pl-2 py-1">
              <div className="text-n-500">
                {i + 1}.{' '}
                {s.section
                  ? `${s.section} · p.${s.page}`
                  : `Chunk ${s.chunkIndex + 1} of the document`}
              </div>
              <div className="text-n-700 leading-snug">
                {s.preview}
                {s.preview && s.preview.length >= 160 ? '…' : ''}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-n-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  'w-full px-3 py-2 rounded-md border border-divider bg-n-100 text-sm text-ink outline-none focus:border-accent';
