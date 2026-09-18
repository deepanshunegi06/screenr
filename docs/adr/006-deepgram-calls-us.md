# 006 — Deepgram calls us, not the other way around

**Status:** superseded by [007](007-deepgram-managed-think.md). Kept for the reasoning; the callback design was built, measured, and replaced.

## Context

Deepgram's Voice Agent API can run a whole voice agent: speech in, an LLM in the
middle, speech out, with turn-taking and barge-in handled. Handing it the system
prompt and letting it drive is the documented happy path and by far the least code.

It is also the wrong shape for this project. In that mode the model's turn happens
inside Deepgram, which means the tools, the probe budget, the evidence recording
and the LangGraph checkpoint are all outside the loop that matters. The branching
is the project; conceding it to the speech vendor would leave a voice chatbot.

## Decision

`think.provider.type` is `open_ai` with `think.endpoint.url` pointed back at this
service. Deepgram handles audio and turn-taking, then calls
`POST /v1/chat/completions/{invite_token}` for each turn. Behind that endpoint the
LangGraph agent runs exactly as it does in the typed interview — same tools, same
state, same caps.

The invite token in the path identifies the session. Deepgram re-sends the whole
message list every turn and we ignore all but the newest candidate message: the
authoritative history is the checkpoint, not whatever the speech layer is holding.

Note for anyone reading the Deepgram docs alongside this: with a custom endpoint
the `model` field is not supported — the model is whatever the endpoint decides,
which here is `LLM_PROVIDER`.

## Consequences

One extra network hop per turn, between Deepgram and us. Acceptable, and the
reason the deployment region matters more than the hosting provider does.

In exchange: the agent is identical in voice and in text, so the eval suite runs
entirely in text and still tests the thing that ships. That is what keeps
development free — audio costs credit and twenty minutes a run, text costs
neither.

Replacing Deepgram later touches `voice.py` and nothing in `app/agent/`.
