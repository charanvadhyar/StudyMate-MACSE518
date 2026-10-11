const express = require('express');
const c = require('../controllers/admin.controller');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(authenticate, requireAdmin);

router.get('/overview', c.overview);
router.get('/nodes', c.nodes);
router.get('/schema', c.schema);
router.get('/tables/:ks/:table/rows', c.rows);
router.get('/users', c.users);
router.post('/users/:id/:action', c.userAction);
router.get('/audit', c.auditLog);
router.get('/metrics', c.apiMetrics);

module.exports = router;
