# 007 — Deepgram runs the voice loop; our tools hold the state

**Status:** accepted. Supersedes 006.

## Context

006 planned for Deepgram to call back into our own `/v1/chat/completions` so that
LangGraph ran every voice turn. Building it showed the cost: one more network hop
per turn on a spoken conversation, and a public URL requirement for local
development.

Deepgram's managed think provider with client-side function calling turned out to
give up less than expected. The model runs on their side, but every state change
still goes through our tools, and the prompt is ours and refreshed each turn.

## Decision

Voice interviews use Deepgram's managed think provider (`claude-sonnet-5`) with
our tools registered as functions. `deepgram_driver.py` executes each
`FunctionCallRequest` against the session's `InterviewContext`, persists, and
pushes an `UpdatePrompt` so the model's next thought sees current state.

LangGraph remains the driver for the typed path, the CLI and the evals, over the
same tools, prompt and scoring.

## Consequences

Evals run in text against the guarantees that ship — quote verification, probe
budgets, escalation-as-annotation, scoring arithmetic — because those live in the
shared layer, not in either driver. What they cannot test is Deepgram's model
following the prompt as well as Groq's does; that is checked by hand with
`inject_text`.

Resume works differently on each path: Deepgram replays history from our
transcript; LangGraph checkpoints in memory. Both end at the same context.

Latency: one round-trip per tool call between Deepgram and us, a few hundred
milliseconds on the same continent. Acceptable. Deploy near the candidates.
