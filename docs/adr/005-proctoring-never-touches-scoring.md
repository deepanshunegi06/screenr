# 005 — Integrity signals and capability scores stay separate

**Status:** accepted

## Context

Proctoring is easy to add and easy to get wrong. The obvious design — collect
signals, fold them into a number, call it a trust score — produces a system that
quietly penalises candidates for looking away while thinking.

Face and gaze data is biometric data. Under India's DPDP Act it needs explicit,
specific consent, separate from general terms. The EU AI Act classifies
recruitment AI as high-risk and prohibits emotion inference in employment. Gaze
analytics sits close enough to that line to stay on the right side of it
deliberately.

There is also an accuracy problem underneath the legal one. Every browser-side
signal is defeated by a phone propped next to the laptop. Anything claiming to
prevent cheating is overselling; these signals only ever narrow where a human
should look.

## Decision

Two sources, both in the candidate's browser: tab or window switches of three
seconds or more, and — only if the candidate opts in — face presence from
MediaPipe's short-range detector running on their device.

Enforced boundaries:

1. Integrity events are stored on `Session.integrity`, never on the
   `InterviewContext` that `scoring.py` receives. The scoring input structurally
   cannot contain them.
2. Video frames never leave the browser and are never stored. Only events, each
   with a timestamp: "no one in frame for 12s", "2 people in frame",
   "switched away for 14s".
3. Camera checks have their own checkbox, separate from recording consent.
   Declining runs the interview unproctored and changes nothing else.
4. An absence has to last eight seconds before it counts, and the same condition
   is reported at most once a minute. People lean out of frame to think.
5. No signal, alone or combined, rejects anyone. They surface next to the
   transcript, with a timestamp, for a human to interpret.

## Signals deliberately not collected

Gaze direction, emotion, attentiveness, stress, speech rate, filler-word counts,
and any aggregate "suspicion score". MediaPipe offers landmarks that would make
gaze estimation easy; it is left out on purpose. Uncalibrated gaze cannot tell
reading a second monitor from thinking, and every one of these punishes
neurodivergent and disabled candidates for how they behave rather than what they
said. None would improve a hiring decision.

## Consequences

The system detects less than it could. That is the intended trade.

The stronger anti-cheat is architectural anyway: an answer read off a second
screen collapses under an unscripted follow-up about the candidate's own claim.
`evals/personas.py` includes a bluffer to demonstrate it.
