const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const multer = require('multer');
const ctrl = require('../controllers/documents.controller');

// PDFs are held in memory just long enough to be read; nothing is written to disk here
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

router.use(authenticate); // all document routes require a valid token

router.post('/', ctrl.createDocument);
router.post('/upload', upload.single('file'), ctrl.uploadPdf);
router.get('/', ctrl.listDocuments);
router.get('/indexing', ctrl.listIndexing);
router.get('/compare/:jobId', ctrl.compareStatus);
router.post('/compare/:jobId/search', ctrl.compareSearch);
router.post('/compare/:jobId/selftest', ctrl.compareSelfTest);
router.delete('/compare/:jobId', ctrl.compareClose);
router.post('/:documentId/compare', ctrl.startCompare);
router.get('/:documentId', ctrl.getDocument);
router.get('/:documentId/index-status', ctrl.getIndexStatus);
router.put('/:documentId', ctrl.updateDocument);
router.delete('/:documentId', ctrl.deleteDocument);
router.post('/:documentId/summarize', ctrl.summarizeDocument);

module.exports = router;
