import React, { useEffect, useState } from 'react';
import { PageHeader } from '../layout/AppShell';
import {
  getDashboard,
  getSubjectReport,
  getActivity,
  getLeaderboard,
  getWeakTopics,
} from '../api/endpoints';
import { errMsg } from '../api/client';
import { StatCard, Loading, ErrorBanner, EmptyState } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const activityIcon = { upload: '⇧', summary: '≡', quiz: '?', evaluation: '★' };

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [subjects, setSubjects] = useState([]);
  const [activity, setActivity] = useState([]);
  const [leaders, setLeaders] = useState([]);
  const [weak, setWeak] = useState({ threshold: 50, weakSubjects: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [d, s, a, l, w] = await Promise.all([
        getDashboard(),
        getSubjectReport(),
        getActivity(20),
        getLeaderboard(10),
        getWeakTopics(50),
      ]);
      setData(d);
      setSubjects(s);
      setActivity(a);
      setLeaders(l);
      setWeak(w);
    } catch (err) {
      setError(errMsg(err, 'Could not load your dashboard'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Welcome back, ${user?.name || 'Student'}.`} />
      <div className="px-6 md:px-8 pb-10">
        <ErrorBanner message={error} onRetry={load} />
        {loading ? (
          <Loading label="Building your dashboard…" />
        ) : (
          <div className="flex flex-col gap-6">
            {/* stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="Documents" value={data?.totals?.documents ?? 0} />
              <StatCard label="Quizzes" value={data?.totals?.quizzesTaken ?? 0} />
              <StatCard label="Evaluations" value={data?.totals?.evaluations ?? 0} />
              <StatCard label="Avg quiz" value={`${data?.quizPerformance?.averageScorePercent ?? 0}%`} />
              <StatCard label="Avg eval" value={`${data?.evaluationPerformance?.averageScorePercent ?? 0}%`} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* subject performance — spans 2 cols */}
              <section className="lg:col-span-2 bg-surface rounded-lg border border-divider p-5">
                <h2 className="font-heading text-xl mb-3">Subject performance</h2>
                {subjects.length === 0 ? (
                  <EmptyState title="No subject data yet" hint="Take a quiz to start tracking." />
                ) : (
                  <div className="overflow-x-auto sm-scroll">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-n-600 border-b border-divider">
                          <th className="py-2 pr-3">Subject</th>
                          <th className="py-2 px-3">Avg quiz %</th>
                          <th className="py-2 px-3">Attempts</th>
                          <th className="py-2 pl-3">Avg eval</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subjects.map((s) => (
                          <tr key={s.subject} className="border-b border-divider/60">
                            <td className="py-2 pr-3">{s.subject}</td>
                            <td className="py-2 px-3">{s.avgQuizPercent ?? '—'}{s.avgQuizPercent != null ? '%' : ''}</td>
                            <td className="py-2 px-3">{s.quizAttempts}</td>
                            <td className="py-2 pl-3">{s.avgEvalScore ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* weak topics */}
                <div className="mt-5">
                  <h3 className="text-xs text-n-600 mb-2">
                    Weak topics (below {weak.threshold}%)
                  </h3>
                  {weak.weakSubjects.length === 0 ? (
                    <p className="text-sm text-good">No weak areas — nice work.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {weak.weakSubjects.map((w) => (
                        <span
                          key={w.subject}
                          className="px-2 py-1 rounded-md text-sm bg-bad/10 text-bad border border-bad/30"
                        >
                          {w.subject} · {w.avgQuizPercent}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* leaderboard */}
              <section className="bg-surface rounded-lg border border-divider p-5">
                <h2 className="font-heading text-xl mb-3">Leaderboard</h2>
                {leaders.length === 0 ? (
                  <EmptyState title="No rankings yet" />
                ) : (
                  <ol className="flex flex-col gap-1">
                    {leaders.map((l) => {
                      const isMe = l.userId === user?.userId;
                      return (
                        <li
                          key={l.userId}
                          className={`flex items-center justify-between px-2 py-1.5 rounded-md text-sm ${
                            isMe ? 'bg-accent/10 text-accent' : ''
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-5 text-n-500">{l.rank}</span>
                            <span>{l.name}</span>
                          </span>
                          <span className="font-medium">{l.averageScorePercent}%</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </div>

            {/* recent activity */}
            <section className="bg-surface rounded-lg border border-divider p-5">
              <h2 className="font-heading text-xl mb-3">Recent activity</h2>
              {activity.length === 0 ? (
                <EmptyState title="Nothing here yet" hint="Your study activity will show up here." />
              ) : (
                <ul className="flex flex-col divide-y divide-divider/60">
                  {activity.map((a, i) => (
                    <li key={i} className="flex items-center gap-3 py-2 text-sm">
                      <span className="w-6 h-6 grid place-items-center rounded-md bg-accent/10 text-accent text-xs shrink-0">
                        {activityIcon[a.type] || '•'}
                      </span>
                      <span className="flex-1">{a.description}</span>
                      <span className="text-xs text-n-500 shrink-0">{relTime(a.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
