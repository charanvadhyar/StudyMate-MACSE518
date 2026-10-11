const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/chat.controller');

router.use(authenticate);

router.post('/sessions', ctrl.createSession);
router.get('/sessions', ctrl.listSessions);
router.get('/sessions/:sessionId/messages', ctrl.getMessages);
router.post('/sessions/:sessionId/messages', ctrl.sendMessage);

module.exports = router;
