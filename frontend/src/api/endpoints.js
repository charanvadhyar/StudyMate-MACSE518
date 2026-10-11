import api from './client';

// ---- Auth ----
export const register = (body) => api.post('/api/auth/register', body).then((r) => r.data);
export const login = (body) => api.post('/api/auth/login', body).then((r) => r.data);

// ---- Documents ----
export const listDocuments = () => api.get('/api/documents').then((r) => r.data);
export const createDocument = (body) => api.post('/api/documents', body).then((r) => r.data);
// send the PDF itself: the server keeps its chapters, sections and page numbers
export const uploadPdf = ({ file, title, subject }) => {
  const form = new FormData();
  form.append('file', file);
  form.append('title', title);
  form.append('subject', subject);
  return api.post('/api/documents/upload', form, { timeout: 300000 }).then((r) => r.data);
};
export const getDocument = (id) => api.get(`/api/documents/${id}`).then((r) => r.data);
export const updateDocument = (id, body) => api.put(`/api/documents/${id}`, body).then((r) => r.data);
export const deleteDocument = (id, uploadedAt) =>
  api.delete(`/api/documents/${id}`, { data: { uploadedAt } }).then((r) => r.data);
export const summarizeDocument = (id) =>
  api.post(`/api/documents/${id}/summarize`).then((r) => r.data);
// retrieval index progress for one document: { state: 'indexing'|'ready'|'failed'|'unknown', done, total }
// every document being indexed right now: { retrievalEnabled, items: [{documentId, state, done, total}] }
export const listIndexing = () => api.get('/api/documents/indexing').then((r) => r.data);
export const getIndexStatus = (id) =>
  api.get(`/api/documents/${id}/index-status`).then((r) => r.data);
// live three-way indexing comparison for one document (see LiveCompareModal)
export const startCompare = (id) => api.post(`/api/documents/${id}/compare`).then((r) => r.data);
export const getCompare = (jobId) => api.get(`/api/documents/compare/${jobId}`).then((r) => r.data);
// quality: one question through the three indexes, and an LLM-written self-test
export const compareSearch = (jobId, query) =>
  api.post(`/api/documents/compare/${jobId}/search`, { query }).then((r) => r.data);
export const compareSelfTest = (jobId, questions = 20) =>
  api.post(`/api/documents/compare/${jobId}/selftest`, { questions }, { timeout: 600000 }).then((r) => r.data);
export const closeCompare = (jobId) =>
  api.delete(`/api/documents/compare/${jobId}`).then((r) => r.data).catch(() => null);

// ---- Health (no auth): { status, aiProvider, retrieval: { enabled, reachable } }
export const getHealth = () => api.get('/api/health').then((r) => r.data);

// ---- Chat ----
export const listSessions = () => api.get('/api/chat/sessions').then((r) => r.data);
export const createSession = (body) => api.post('/api/chat/sessions', body).then((r) => r.data);
export const getMessages = (sessionId) =>
  api.get(`/api/chat/sessions/${sessionId}/messages`).then((r) => r.data);
export const sendMessage = (sessionId, body) =>
  api.post(`/api/chat/sessions/${sessionId}/messages`, body).then((r) => r.data);

// ---- Quizzes ----
export const generateQuiz = (documentId, body) =>
  api.post(`/api/quizzes/documents/${documentId}/generate`, body).then((r) => r.data);
export const listQuizzes = (documentId) =>
  api.get(`/api/quizzes/documents/${documentId}`).then((r) => r.data);
export const submitAttempt = (documentId, quizId, body) =>
  api.post(`/api/quizzes/documents/${documentId}/quizzes/${quizId}/attempt`, body).then((r) => r.data);
export const listAttempts = () => api.get('/api/quizzes/attempts').then((r) => r.data);

// ---- Evaluations ----
export const evaluateAnswer = (body) => api.post('/api/evaluations', body).then((r) => r.data);
export const listEvaluations = () => api.get('/api/evaluations').then((r) => r.data);

// ---- Analytics ----
export const getDashboard = () => api.get('/api/analytics/dashboard').then((r) => r.data);
export const getSubjectReport = () => api.get('/api/analytics/subjects').then((r) => r.data);
export const getActivity = (limit = 20) =>
  api.get(`/api/analytics/activity?limit=${limit}`).then((r) => r.data);
export const getLeaderboard = (limit = 10) =>
  api.get(`/api/analytics/leaderboard?limit=${limit}`).then((r) => r.data);
export const getWeakTopics = (threshold = 50) =>
  api.get(`/api/analytics/weak-topics?threshold=${threshold}`).then((r) => r.data);

// ---- Admin (accounts listed in ADMIN_EMAILS on the server) ----
export const adminOverview = () => api.get('/api/admin/overview').then((r) => r.data);
export const adminNodes = () => api.get('/api/admin/nodes').then((r) => r.data);
export const adminSchema = () => api.get('/api/admin/schema').then((r) => r.data);
export const adminRows = (ks, table, { pageState, where, limit = 25 } = {}) =>
  api
    .get(`/api/admin/tables/${encodeURIComponent(ks)}/${encodeURIComponent(table)}/rows`, {
      params: { limit, pageState: pageState || undefined, where: where ? JSON.stringify(where) : undefined },
    })
    .then((r) => r.data);
export const adminUsers = () => api.get('/api/admin/users').then((r) => r.data);
export const adminUserAction = (id, action) => api.post(`/api/admin/users/${id}/${action}`).then((r) => r.data);
export const adminAudit = () => api.get('/api/admin/audit').then((r) => r.data);
export const adminMetrics = () => api.get('/api/admin/metrics').then((r) => r.data);
