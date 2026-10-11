import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getHealth } from '../api/endpoints';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/documents', label: 'Documents' },
  { to: '/chat', label: 'Chat' },
  { to: '/quiz', label: 'Quiz' },
  { to: '/evaluator', label: 'Evaluator' },
];

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-[34px] h-[34px] grid place-items-center border border-accent rounded-sm font-heading text-[13px] tracking-widest text-accent">
        SM
      </div>
      <div>
        <div className="font-heading font-semibold text-lg leading-none">StudyMate</div>
        <div className="text-[11px] text-n-500">Study assistant</div>
      </div>
    </div>
  );
}

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  // how answers are being grounded right now (retrieval index vs whole document)
  const [retrieval, setRetrieval] = useState(null);
  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => alive && setRetrieval(h.retrieval || null))
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const retrievalOn = retrieval?.enabled && retrieval?.reachable;

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const navItems = (
    <nav className="flex flex-col gap-0.5 px-3">
      {(user?.isAdmin ? [...NAV, { to: '/admin', label: 'Admin' }] : NAV).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            `px-3 py-2 rounded-md text-sm transition ${
              isActive ? 'bg-accent/10 text-accent' : 'text-ink/80 hover:bg-ink/5'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[252px_1fr] bg-bg text-ink font-body">
      {/* mobile top bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-divider">
        <Logo />
        <button onClick={() => setMobileOpen((v) => !v)} className="text-2xl leading-none" aria-label="menu">
          ≡
        </button>
      </div>

      {/* sidebar */}
      <aside
        className={`${
          mobileOpen ? 'block' : 'hidden'
        } md:flex md:flex-col border-r border-divider bg-n-100/60 py-4 md:sticky md:top-0 md:h-screen`}
      >
        <div className="px-4 pb-4 hidden md:block">
          <Logo />
        </div>
        <hr className="border-divider mx-4 mb-3 hidden md:block" />
        {navItems}
        <div className="mt-auto px-4 pt-4">
          <hr className="border-divider mb-3" />
          <div className="text-sm">
            <div className="font-medium truncate">{user?.name || 'Student'}</div>
            <div className="text-xs text-n-500 truncate">{user?.email}</div>
          </div>
          <button onClick={doLogout} className="mt-3 text-xs text-n-600 hover:text-bad underline">
            Log out
          </button>
          {retrieval && (
            <div className="mt-3 text-[11px] text-n-500 flex items-center gap-1.5" title={
              retrievalOn
                ? 'Answers use the most relevant passages of a document'
                : 'Answers use the whole document as context'
            }>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${retrievalOn ? 'bg-good' : 'bg-n-400'}`} />
              {retrievalOn ? 'Focused retrieval on' : 'Whole-document mode'}
            </div>
          )}
        </div>
      </aside>

      {/* main content */}
      <main className="min-h-screen overflow-x-hidden">{children}</main>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 md:px-8 pt-6 md:pt-8 pb-4">
      <div>
        <h1 className="font-heading text-3xl text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-n-600 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
