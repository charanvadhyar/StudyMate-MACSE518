const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/evaluation.controller');

router.use(authenticate);

// AI evaluator endpoints
router.post('/', ctrl.evaluateAnswer);       // grade a free-text answer
router.get('/', ctrl.listEvaluations);       // evaluation history (dashboard)
router.get('/one', ctrl.getEvaluation);      // single evaluation by keys

module.exports = router;
