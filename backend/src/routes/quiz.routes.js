const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/quiz.controller');

router.use(authenticate);

router.post('/documents/:documentId/generate', ctrl.generateQuiz);
router.get('/documents/:documentId', ctrl.listQuizzes);
router.post('/documents/:documentId/quizzes/:quizId/attempt', ctrl.submitAttempt);
router.get('/attempts', ctrl.listAttempts);

module.exports = router;
