# 001 — LangGraph, not CrewAI or AutoGen

**Status:** accepted

## Context

The interviewer has to survive a dropped connection. Candidates take these calls
on hotel wifi and phone hotspots; losing fourteen minutes of interview because a
socket closed is not an edge case, it is a Tuesday.

That means interview state has to be persisted per turn and reloadable by session
id, and the agent has to resume mid-conversation without re-asking anything.

## Options

**CrewAI / AutoGen.** Both model a conversation between multiple agents. There is
only one agent here, and one candidate. The multi-agent machinery is weight I
would carry without using, and neither gives durable per-turn state out of the box.

**Hand-rolled loop.** A `while` loop around a tool-calling model is about forty
lines. I would then write my own state persistence, my own replay, my own step
caps. That is the LangGraph checkpointer, badly.

**LangGraph.** The graph is small — an agent node and a tool node — but the
checkpointer persists state per thread id, keyed on the session. Resume is a
property of the framework rather than something I maintain.

## Decision

LangGraph, with a Postgres checkpointer in production and none in tests.

## Consequences

The graph topology is almost trivial, and that is fine: the branching lives in
which tools the model chooses, not in the edges. Anyone reading `graph.py`
expecting a complicated diagram will be disappointed, so `evals/test_branching.py`
exists to demonstrate the branching is real.

A hand-rolled loop would have been fewer lines on day one and more lines by week
three.
