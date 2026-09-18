# screenr — web

Next.js 16 frontend for the recruiter dashboard, scorecards, roles, evals, and
the candidate's interview room.

```bash
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Routes:

- `/` — sign in, then the interview queue
- `/sessions/[id]` — a scorecard
- `/roles`, `/roles/[key]` — rubrics
- `/evals` — committed eval runs with per-persona tool sequences
- `/interview/[token]` — the candidate's room (consent → interview → done)

Design tokens live in `app/globals.css`; primitives in `components/ui.tsx`. See
`../docs/design.md`.
