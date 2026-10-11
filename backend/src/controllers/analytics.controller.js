/**
 * analytics.controller.js — READ-HEAVY features.
 *
 * Demonstrates the Cassandra approach to analytical reads:
 *   - counter reads (user_stats)                          -> instant totals
 *   - single-partition aggregate functions (COUNT/AVG)     -> per-user rollups
 *   - counter rollup division (user_subject_stats)         -> per-subject averages
 *   - fan-in-on-write timeline (activity_feed)             -> recent activity
 *   - pre-sorted ranked partition (leaderboard)            -> top students
 *   - application-side "subquery"/HAVING (weak topics)     -> filter on aggregates
 *   - application-side "join" (dashboard)                  -> combine multiple tables
 */
const { types } = require('cassandra-driver');
const { client } = require('../config/cassandra');

// ---------------------------------------------------------------
// 1. PROGRESS DASHBOARD (report #1)
//    Combines counter totals + single-partition aggregates +
//    subject rollups. This is an application-side "join": data
//    from user_stats, quiz_attempts and user_subject_stats is
//    fetched separately and merged in code (Cassandra has no joins).
// ---------------------------------------------------------------
async function getDashboard(req, res) {
  try {
    const userId = req.userId;

    // (a) counter totals — single partition read
    const statsRow = await client.execute(
      'SELECT * FROM user_stats WHERE user_id = ?',
      [userId],
      { prepare: true }
    );
    const stats = statsRow.first() || {};

    // (b) single-partition AGGREGATE query — avg quiz score & count.
    //     COUNT/AVG are efficient here because they are scoped to one
    //     partition (WHERE user_id = ?), not a full-table scan.
    const quizAgg = await client.execute(
      'SELECT COUNT(*) AS attempts, AVG(score) AS avg_score, AVG(total_questions) AS avg_total FROM quiz_attempts WHERE user_id = ?',
      [userId],
      { prepare: true }
    );
    const qa = quizAgg.first() || {};

    // (c) single-partition AGGREGATE — avg evaluation score
    const evalAgg = await client.execute(
      'SELECT COUNT(*) AS count, AVG(ai_score) AS avg_score, AVG(max_score) AS avg_max FROM evaluations WHERE user_id = ?',
      [userId],
      { prepare: true }
    );
    const ea = evalAgg.first() || {};

    const avgQuizPct =
      qa.avg_total && Number(qa.avg_total) > 0
        ? Math.round((Number(qa.avg_score) / Number(qa.avg_total)) * 100)
        : 0;
    const avgEvalPct =
      ea.avg_max && Number(ea.avg_max) > 0
        ? Math.round((Number(ea.avg_score) / Number(ea.avg_max)) * 100)
        : 0;

    return res.json({
      totals: {
        documents: Number(stats.documents_count || 0),
        summaries: Number(stats.summaries_count || 0),
        quizzesTaken: Number(stats.quizzes_taken || 0),
        evaluations: Number(stats.evaluations_done || 0),
        chatMessages: Number(stats.chat_messages_count || 0),
      },
      quizPerformance: {
        attempts: Number(qa.attempts || 0),
        averageScorePercent: avgQuizPct,
      },
      evaluationPerformance: {
        count: Number(ea.count || 0),
        averageScorePercent: avgEvalPct,
      },
    });
  } catch (err) {
    console.error('[getDashboard]', err);
    return res.status(500).json({ error: 'Failed to build dashboard' });
  }
}

// ---------------------------------------------------------------
// 2. SUBJECT-WISE PERFORMANCE REPORT (report #2)
//    Reads the user's subject rollup partition and turns counter
//    sums into per-subject averages (sum / count).
// ---------------------------------------------------------------
async function getSubjectReport(req, res) {
  try {
    const rows = await client.execute(
      'SELECT subject, total_quiz_score, total_quiz_questions, quiz_attempts, total_eval_score, eval_count FROM user_subject_stats WHERE user_id = ?',
      [req.userId],
      { prepare: true }
    );

    const report = rows.rows.map((r) => {
      const quizQ = Number(r.total_quiz_questions || 0);
      const quizS = Number(r.total_quiz_score || 0);
      const evalC = Number(r.eval_count || 0);
      const evalS = Number(r.total_eval_score || 0);
      return {
        subject: r.subject,
        quizAttempts: Number(r.quiz_attempts || 0),
        avgQuizPercent: quizQ > 0 ? Math.round((quizS / quizQ) * 100) : null,
        evaluations: evalC,
        avgEvalScore: evalC > 0 ? Math.round((evalS / evalC) * 10) / 10 : null,
      };
    });

    // sort strongest-to-weakest by quiz % for the report view
    report.sort((a, b) => (b.avgQuizPercent || 0) - (a.avgQuizPercent || 0));
    return res.json(report);
  } catch (err) {
    console.error('[getSubjectReport]', err);
    return res.status(500).json({ error: 'Failed to build subject report' });
  }
}

// ---------------------------------------------------------------
// 3. RECENT ACTIVITY FEED
//    Single ordered partition read (newest first).
// ---------------------------------------------------------------
async function getActivityFeed(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = await client.execute(
      'SELECT event_at, event_type, description FROM activity_feed WHERE user_id = ? LIMIT ?',
      [req.userId, limit],
      { prepare: true }
    );
    return res.json(
      rows.rows.map((r) => ({
        at: r.event_at,
        type: r.event_type,
        description: r.description,
      }))
    );
  } catch (err) {
    console.error('[getActivityFeed]', err);
    return res.status(500).json({ error: 'Failed to fetch activity feed' });
  }
}

// ---------------------------------------------------------------
// 4. LEADERBOARD
//    Pre-sorted single-partition ranked read (top N students).
// ---------------------------------------------------------------
async function getLeaderboard(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const rows = await client.execute(
      "SELECT avg_score, user_id, name FROM leaderboard WHERE bucket = 'all-time' LIMIT ?",
      [limit],
      { prepare: true }
    );
    return res.json(
      rows.rows.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        userId: r.user_id.toString(),
        averageScorePercent: r.avg_score,
      }))
    );
  } catch (err) {
    console.error('[getLeaderboard]', err);
    return res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}

// ---------------------------------------------------------------
// 5. WEAK TOPICS (subquery / HAVING equivalent)
//    CQL has no subqueries or HAVING. The pattern: run the
//    aggregate query, then filter its results in the application
//    layer. Here: subjects whose avg quiz % is below a threshold.
// ---------------------------------------------------------------
async function getWeakTopics(req, res) {
  try {
    const threshold = Math.min(Math.max(parseInt(req.query.threshold, 10) || 50, 0), 100);

    // "inner query": per-subject aggregates
    const rows = await client.execute(
      'SELECT subject, total_quiz_score, total_quiz_questions FROM user_subject_stats WHERE user_id = ?',
      [req.userId],
      { prepare: true }
    );

    // "outer filter": keep only subjects below the threshold (HAVING equiv.)
    const weak = rows.rows
      .map((r) => {
        const q = Number(r.total_quiz_questions || 0);
        const s = Number(r.total_quiz_score || 0);
        return { subject: r.subject, avgQuizPercent: q > 0 ? Math.round((s / q) * 100) : null };
      })
      .filter((r) => r.avgQuizPercent !== null && r.avgQuizPercent < threshold)
      .sort((a, b) => a.avgQuizPercent - b.avgQuizPercent);

    return res.json({ threshold, weakSubjects: weak });
  } catch (err) {
    console.error('[getWeakTopics]', err);
    return res.status(500).json({ error: 'Failed to compute weak topics' });
  }
}

// ---------------------------------------------------------------
// 6. LEADERBOARD RECOMPUTE (admin/utility)
//    Rebuilds the leaderboard from each user's subject rollups.
//    Enumerating all users is a full-table scan — acceptable at
//    project scale; at production scale this would be a scheduled
//    job over paged reads. Demonstrates a deliberate read-heavy
//    batch operation.
// ---------------------------------------------------------------
async function recomputeLeaderboard(req, res) {
  try {
    const users = await client.execute('SELECT user_id, name FROM users', [], { prepare: true });

    let updated = 0;
    for (const u of users.rows) {
      const sub = await client.execute(
        'SELECT total_quiz_score, total_quiz_questions FROM user_subject_stats WHERE user_id = ?',
        [u.user_id],
        { prepare: true }
      );
      let score = 0,
        total = 0;
      for (const r of sub.rows) {
        score += Number(r.total_quiz_score || 0);
        total += Number(r.total_quiz_questions || 0);
      }
      const avgPct = total > 0 ? Math.round((score / total) * 100) : 0;

      await client.execute(
        'INSERT INTO leaderboard (bucket, avg_score, user_id, name) VALUES (?, ?, ?, ?)',
        ['all-time', avgPct, u.user_id, u.name],
        { prepare: true }
      );
      updated++;
    }
    return res.json({ rebuilt: updated });
  } catch (err) {
    console.error('[recomputeLeaderboard]', err);
    return res.status(500).json({ error: 'Failed to recompute leaderboard' });
  }
}

module.exports = {
  getDashboard,
  getSubjectReport,
  getActivityFeed,
  getLeaderboard,
  getWeakTopics,
  recomputeLeaderboard,
};
