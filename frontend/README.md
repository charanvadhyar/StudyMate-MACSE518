# StudyMate — Frontend

React (Create React App) + Tailwind CSS UI for StudyMate, wired to the Node/Express + Cassandra backend.

## Run

```bash
npm install
cp .env.example .env      # then set REACT_APP_API_URL if your backend isn't on :4000
npm start                 # http://localhost:3000
```

The backend must be running and seeded first (see the backend README). Log in with a seeded account: `student1@studymate.edu` / `password123`.

## Pages
- `/login`, `/register` — auth (JWT)
- `/` — dashboard (stat cards, subject report, weak topics, leaderboard, activity)
- `/documents` — upload (PDF text-extraction or paste), summarize, edit, delete
- `/chat` — sessions + document-grounded Q&A
- `/quiz` — generate, take, score, history
- `/evaluator` — AI free-text answer grading + history

## Structure
```
src/
├── api/          client.js (axios + token/401), endpoints.js (all API calls)
├── auth/         AuthContext, ProtectedRoute
├── layout/       AppShell (sidebar), PageHeader
├── components/   ui.jsx (Button, Modal, StatCard, ScoreBadge, states…)
└── pages/        Login, Register, Dashboard, Documents, Chat, Quiz, Evaluator
```

## Notes
- The JWT is stored in `localStorage`; a `401` response clears it and redirects to `/login`.
- **PDF upload** extracts text in the browser (pdf.js from CDN) and sends `text` to the backend, matching the backend's `POST /api/documents` contract.
- Config: only `REACT_APP_`-prefixed env vars are exposed (CRA rule).
- Build: `npm run build` (verified — compiles clean).
