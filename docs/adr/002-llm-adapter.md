# 002 — The reasoning model is swappable

**Status:** accepted

## Context

Development started on Groq's free tier, on a zero budget. That constraint should
not leak into the architecture, and the choice of model should be reversible when
the budget or the latency requirements change.

Voice makes this sharper than usual. In a spoken interview, time-to-first-token is
felt directly — a model that is smarter but 800ms slower produces a worse
interview, because the candidate starts talking over the pause.

## Decision

One `build_llm()` factory behind `LLM_PROVIDER` and `LLM_MODEL`. Three
implementations: Groq, Gemini, Anthropic. Nothing in `app/agent/` names a vendor.

Groq is the default: sub-100ms time-to-first-token, free tier, no card. Gemini Flash is the fallback when Groq rate-limits.

## Consequences

Tool-calling behaviour differs between providers more than the interfaces suggest;
the eval suite is what catches that, and it should be re-run after any provider
change rather than assumed equivalent.

The cost of the abstraction is about thirty lines. The cost of not having it is a
rewrite of every call site the first time a provider changes.
