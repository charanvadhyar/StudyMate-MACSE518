const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/analytics.controller');

router.use(authenticate);

// read-heavy analytics / dashboard endpoints
router.get('/dashboard', ctrl.getDashboard);          // report #1: progress dashboard
router.get('/subjects', ctrl.getSubjectReport);       // report #2: subject-wise performance
router.get('/activity', ctrl.getActivityFeed);        // recent activity timeline
router.get('/leaderboard', ctrl.getLeaderboard);      // ranked top students
router.get('/weak-topics', ctrl.getWeakTopics);       // subquery/HAVING equivalent
router.post('/leaderboard/recompute', ctrl.recomputeLeaderboard); // rebuild leaderboard

module.exports = router;
