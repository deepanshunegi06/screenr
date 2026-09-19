# screenr

An agentic voice interviewer for first-round screening. It decides what to ask
next from what the candidate just said, records every judgement against a
verbatim quote, and hands the decision to a person.

[![ci](https://github.com/deepanshunegi06/screenr/actions/workflows/ci.yml/badge.svg)](https://github.com/deepanshunegi06/screenr/actions/workflows/ci.yml)

---

## Agent, not script

Most "AI interviewer" projects are a question list with speech bolted on. The call
sequence is decided by the developer, before anything runs.

Here it is decided by the model, at runtime, from the candidate's answer. The
test: **can you predict the exact sequence of tool calls before running it?** You
can't, because it depends on what the candidate says.

Same rubric, same opening question, two candidates:

```
strong                              bluffer
  record_evidence(ai_agents, 4)       plan_probe(ai_agents)
  mark_claim(c1, verified)            plan_probe(ai_agents)
  record_evidence(api_design, 4)      record_evidence(ai_agents, 1)
  record_evidence(ownership, 5)       plan_probe(backend_depth)
  ...                                 ...
  end_interview(sufficient_evidence)  record_evidence(backend_depth, 2)
```

Nobody wrote the second column. The `/evals` page renders the real sequences
from committed runs, and `api/evals/test_branching.py` fails if the bluffer is not
probed more than the strong candidate.

## What it does

- Reads a rubric and the candidate's résumé, extracts the claims worth probing,
  and opens with the most specific one
- After every answer, decides: record evidence, probe for one checkable detail,
  check a claim against the résumé, flag for a human, or move to an uncovered skill
- Spends a probe budget per skill; when it runs out the skill is recorded as
  insufficient evidence rather than guessed at
- Produces a scorecard where every score points at the sentence that produced it,
  and a coverage map that shows which skills were never reached
- Recommends. A person decides, and that decision is the only one recorded.

Roles are editable in the app: paste a job description and the skills come out
drafted, or write them by hand. Shipped roles stay read-only; yours are written
as YAML next to the database, so they survive a restart and can still be edited
in an editor.

For the person doing the hiring: drop a PDF or Word résumé on the invite and the
claims come out of it; paste a column of thirty addresses and get thirty links
back, with a reason next to any row that failed; send the invite as an email
rather than copying a link into your own client; and `/compare` puts everyone who
interviewed for a role under the same skill columns, because the real question is
which of them to take forward.

One model does all the thinking. Drafting a rubric, running an interview and
re-running the evals all go through `claude-sonnet-5` on Deepgram's socket, so
what the product writes sounds like what candidates hear.

## Rules that are enforced in code, not asked for in a prompt

| Rule | Where it lives |
|---|---|
| No score without a verbatim quote | `record_evidence` rejects quotes that are not ≥70% words the candidate said |
| Uncovered is null, not zero | `scoring.py` — a skill with no evidence has no score |
| The agent never rejects | `Recommendation` has no reject value; only `POST /sessions/{id}/decision` records one, and it needs a signed-in person |
| Integrity signals never touch scoring | Tab-switch events live on `Session.integrity`; `build_scorecard` only ever sees `InterviewContext` |
| Escalation annotates, never ends | `escalate_to_human` sets a flag and the interview continues |
| Time and turn caps | Enforced in both drivers — the voice watchdog and the typed turn loop |

## What runs where

| | Voice interview | Typed fallback, CLI, evals |
|---|---|---|
| Driver | Deepgram Voice Agent (`deepgram_driver.py`, `relay.py`) | LangGraph (`agent/graph.py`) |
| Reasoning model | `claude-sonnet-5` via Deepgram's managed think provider | the same model via `brain.py`, or `llm.py` for offline work |
| Speech | Deepgram Flux STT and TTS | none |
| Tool execution | client-side function calling → our `tools.py` | LangGraph `ToolNode` → the same `tools.py` |
| Memory | Deepgram conversation history, replayed from our transcript on reconnect | `MemorySaver` checkpointer |
| Shared | prompt (`prompts/interviewer.md`), rubric, tools, scoring, `InterviewContext`, SQLite persistence | |

The two drivers differ only in who runs the loop. Everything that has to be true
about an interview is in the shared layer, so the eval suite tests the guarantees
that ship even though it runs in text.

See [docs/architecture.md](docs/architecture.md) for the sequence diagrams and the
Deepgram behaviours that shaped the driver.

## Running it

**API** (Python 3.12, [uv](https://docs.astral.sh/uv/))

```bash
cd api
uv venv --python 3.12
uv pip install -e ".[dev]"
cp env.example .env         # then fill in the keys below
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

| Variable | Needed for |
|---|---|
| `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID` | voice interviews and per-interview cost |
| `VOICE_THINK_PROVIDER`, `VOICE_THINK_MODEL` | the model Deepgram runs (`anthropic` / `claude-sonnet-5`) |
| `SMTP_USER`, `SMTP_PASSWORD` *or* `RESEND_API_KEY` | emailing invites. SMTP wins when both are set, because it is the one that reaches anyone: Resend will not deliver past the account owner's own address until a domain is verified |
| `MAIL_FROM`, `WEB_ORIGIN` | the sender label, and the origin an invite link points at |
| `GROQ_API_KEY` *or* `GOOGLE_API_KEY` | the terminal interviewer and the free text eval sweep only. Everything the product does at runtime thinks through Deepgram |
| `RECRUITER_EMAIL`, `RECRUITER_PASSWORD`, `JWT_SECRET` | the single recruiter account |
| `DEMO_MODE=true` | a one-click demo sign-in that never exposes the password |
| `CORS_ORIGINS` | the frontend origin(s) |

**Web** (Node 22)

```bash
cd web
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

**Both, in containers:** `docker compose up` (reads `api/.env`).

**A public URL for a demo:** `cloudflared tunnel --url http://localhost:8000` and
again for `:3000`; set `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` to the two URLs.

## Interview yourself in the terminal

```bash
cd api
.venv/Scripts/python -m app.cli                      # you are the candidate
.venv/Scripts/python -m app.cli --persona bluffer    # watch a scripted one
```

## Evals

`api/evals/personas.py` holds scripted candidates. Each one is an argument about
the agent, and each run checks the persona's expectations plus the universal
guarantees (every quote verbatim, no question repeated, evidence or a probe on
most turns).

| persona | what it proves |
|---|---|
| `strong` | specific answers get covered fast and the interview closes itself |
| `bluffer` | fluent buzzwords get probed, not rewarded — and never outscore `strong` |
| `contradictory` | a résumé claim the answers contradict gets marked refuted |
| `injector` | spoken instructions to the agent are flagged and ignored |
| `resume_injector` | instructions hidden in the résumé are flagged and ignored |
| `silent` | no answers → inconclusive, not low-scored |

```bash
.venv/Scripts/python -m pytest tests -q                       # no keys needed
.venv/Scripts/python -m pytest evals -q                       # needs GROQ_API_KEY
.venv/Scripts/python -m app.cli --json evals/results/latest.json   # what /evals renders
```

A committed report is only as good as your trust in whoever committed it, so
**Run them now** on the `/evals` page re-runs every persona and rewrites that
file while you watch. It goes through the real Deepgram socket, not the text
stand-in: six interviews at once, about two minutes, billed in agent-hours.
A page claiming "these are the real tool sequences" should mean the stack a
candidate actually talks to.

```bash
.venv/Scripts/python -m app.cli --json evals/results/latest.json --voice
```

If the provider is unreachable and nothing runs, the previous report is kept
rather than replaced with an empty one, and the page says so.

## Decisions

- [001 — LangGraph on the typed path](docs/adr/001-langgraph-over-crewai.md)
- [002 — the reasoning model is swappable](docs/adr/002-llm-adapter.md)
- [003 — our own browser room, not a Google Meet bot](docs/adr/003-no-google-meet-bot.md)
- [004 — one recruiter account](docs/adr/004-no-auth-provider.md)
- [005 — integrity signals never touch scoring](docs/adr/005-proctoring-never-touches-scoring.md)
- [006 — superseded](docs/adr/006-deepgram-calls-us.md) →
  [007 — Deepgram runs the voice loop, our tools hold the state](docs/adr/007-deepgram-managed-think.md)

## Known gaps

- One recruiter account; no roles or tenancy
- Rubrics are YAML files, not editable in the app
- Résumé claim extraction is a verb-pattern regex; dense CVs over-match
- Cost tracking covers Deepgram's agent time only, not the typed path's tokens
- SQLite on one box; a second instance needs Postgres
