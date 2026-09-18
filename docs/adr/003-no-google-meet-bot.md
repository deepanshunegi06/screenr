# 003 — The interview runs in our own browser room, not Google Meet

**Status:** accepted

## Context

"Can the agent join a Google Meet?" is the first question everyone asks. It is
worth answering properly rather than by assumption.

## What I found

Google's Meet Media API cannot do it. The SDP negotiation only offers `recvonly`
audio — Meet never answers `sendrecv`. An application can listen to a meeting. It
cannot speak into one. For an interviewer that is a hard stop, not a limitation to
work around. It is also a gated developer preview requiring every participant to
be enrolled, and it provides no transcription.

The only route to two-way audio is a headless browser joining as a participant:

- a container with a virtual audio sink to capture and a virtual mic to inject
- a real Google account for the bot, surviving login challenges
- the host admitting it from the lobby — Meet auto-denies third-party bots when
  "anyone can ask to join" is disabled
- roughly one vCPU and a gigabyte of RAM per concurrent interview
- permanent breakage risk whenever a DOM selector changes

Managed services (Recall.ai, MeetStream) do this for about $0.35–1.00/hour and
would cut the work to a couple of days, at the cost of money I do not have and a
vendor in the critical path.

## Decision

Own browser room. WebRTC audio straight from the candidate's browser to our
backend, no meeting platform in between.

No transport abstraction was built. The browser room is the only transport; a
Meet integration, if ever needed, would be a Recall.ai-style adapter feeding the
same relay.

## Consequences

Lower latency, which matters more than it sounds — every hop is felt in a spoken
conversation. No lobby, no bot account, no DOM fragility, full control of the
audio pipeline.

What we give up: interviews cannot happen on a platform the candidate already has
open. If that ever becomes a requirement, it is an adapter in front of the relay,
not a rewrite.
