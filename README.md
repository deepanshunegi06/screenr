# screenr

An agentic voice interviewer for first-round screening. It decides what to ask
next based on what the candidate just said, and it never decides who gets hired.

**Status:** agent core working, evals passing. Audio and web UI in progress.

---

## The distinction this project is built around

Most "AI interviewer" projects are a question list with speech bolted on: read
question one, transcribe, read question two, score at the end. The call sequence
is decided by the developer, before anything runs.

Here it is decided by the model, at runtime, from the candidate's answer.

The test: **can you predict the exact sequence of tool calls before running it?**
If yes, it's a workflow. Here you can't, because it depends on what the candidate
says.

Same opening question, two candidates:

```
candidate A (specific)          candidate B (vague)
  retrieve_rubric(ai_agents)      retrieve_rubric(ai_agents)
  record_evidence(4.5)            plan_probe("rag")
  record_evidence(4)              record_evidence(2)
  end_interview(sufficient)       plan_probe("rag")
                                  get_resume_section("RAG pipeline")
                                  mark_claim(c2, refuted)
```

Nobody wrote that second branch. `evals/test_branching.py` fails if the two paths
ever converge.

## What it does

- Reads a rubric and the candidate's résumé, and extracts the claims worth probing
- Opens the interview, then after every answer decides: score it and move on, probe
  for a specific detail, skip ahead because the answer was strong, check a claim
  against the résumé, or hand over to a human
- Spends a probe budget per topic — when it runs out, the skill is recorded as
  *insufficient evidence* rather than guessed at
- Produces a scorecard where every score is backed by the candidate's own words
- Recommends. A human decides.

## Design rules that are not negotiable

**The agent never rejects anyone.** `scoring.py` can emit `advance`,
`another_round`, or `inconclusive`. There is no reject verdict and no code path
that acts on a recommendation. A test asserts this.

**No score without a quote.** `record_evidence` rejects an empty quote. Every
number on the scorecard links to the transcript line that produced it.

**Uncovered is not zero.** A skill nobody asked about has a score of `null`, not
0. "We ran out of time" and "they were weak" are different findings and must not
collapse into the same number.

**Content only.** The prompt instructs the model to judge specificity, decisions
and honesty — never accent, fluency, speed, grammar, or hesitation. A slow correct
answer beats a fast empty one.

**Integrity signals never reach scoring.** Proctoring events live on the session
and are shown to the recruiter. `scoring.py` does not import them.
See [ADR 005](docs/adr/005-proctoring-never-touches-scoring.md).

## Running it

Everything below runs with no audio and no Deepgram credit. This is how it is
developed: text is fast and nearly free, so the agent's behaviour gets exercised
hundreds of times before a microphone is involved.

```bash
cd api
uv venv --python 3.12
uv pip install -e ".[dev]"
cp env.example .env        # add your GROQ_API_KEY
```

Interview yourself:

```bash
python -m app.cli
```

Watch a scripted candidate, and see which tools the agent chose:

```bash
python -m app.cli --persona bluffer
python -m app.cli --persona all
```

Tests — the scoring suite needs no keys and no network:

```bash
python -m pytest tests -q          # arithmetic, claim extraction, guarantees
python -m pytest evals -q          # live agent behaviour, needs GROQ_API_KEY
```

## Evals

`evals/personas.py` holds scripted candidates, each one an argument about the
agent:

| persona | what it is for |
|---|---|
| `strong` | specific, first-person answers with real numbers and a real failure |
| `bluffer` | fluent buzzwords, no detail — must not outscore `strong` |
| `contradictory` | résumé claims leadership, answers say otherwise |
| `injector` | tries to instruct the agent to score itself 5 |
| `silent` | no answers — must produce `inconclusive`, not a low score |

Scripting the candidate side holds it constant, so any difference in behaviour is
attributable to the agent rather than to the person.

## Stack

Python 3.12, FastAPI, LangGraph, Groq (Llama 3.3 70B), Postgres with pgvector,
fastembed for local embeddings, Next.js, Deepgram for speech.

Every piece has a free tier with no credit card. Total running cost: zero.

## Decisions

- [001 — LangGraph, not CrewAI](docs/adr/001-langgraph-over-crewai.md) — resumable
  interviews are the requirement; the checkpointer is the reason
- [002 — the reasoning model is swappable](docs/adr/002-llm-adapter.md) — no vendor
  name inside `app/agent/`
- [003 — no Google Meet bot](docs/adr/003-no-google-meet-bot.md) — the Meet Media
  API is receive-only, so an agent can listen but not speak
- [004 — one hardcoded recruiter](docs/adr/004-no-auth-provider.md) — a known gap,
  written down as one
- [005 — proctoring never touches scoring](docs/adr/005-proctoring-never-touches-scoring.md)

## Not used, on purpose

No Kubernetes, no Redis, no Celery, no microservices, no Mongo, no managed vector
database. One Postgres instance does relational and vector work; at this scale a
second data store would be a moving part with nothing to do.

No CrewAI or AutoGen: there is one agent and one candidate, and what was needed
was a state machine with durable checkpoints, not a conversation between models.

## Known gaps

- Audio pipeline not wired yet — the agent runs in text
- One recruiter account ([ADR 004](docs/adr/004-no-auth-provider.md))
- Résumé claim extraction is a regex over action verbs; it over-matches on dense
  CVs and should become a model call with a schema
- No retry when the provider returns a malformed tool call — it currently falls
  through to a filler line
