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

Detection comes from `@timadey/proctor`, which runs on-device in the browser. We
consume its discrete events and discard its aggregate suspicion score. Gaze
estimation is disabled.

Enforced boundaries:

1. Integrity events are stored on `Session.integrity`, never on the
   `InterviewContext` that `scoring.py` receives. The scoring input structurally
   cannot contain them.
2. Video frames are never transmitted or stored. Only events: "no face, 8s",
   "second voice detected", "tab hidden, 14s".
3. Camera analysis has its own consent checkbox. Declining it still allows the
   interview, marked unproctored.
4. No signal, alone or combined, rejects anyone. They surface next to the
   transcript for a human to interpret.

## Signals deliberately not collected

Gaze direction, emotion, attentiveness, stress, speech rate, filler-word counts.
Each is either legally fraught, unreliable, or discriminatory against
neurodivergent and disabled candidates, and none would improve a hiring decision.

## Consequences

The system detects less than it could. That is the intended trade.

The stronger anti-cheat is architectural anyway: an answer read off a second
screen collapses under an unscripted follow-up about the candidate's own claim.
`evals/personas.py` includes a bluffer to demonstrate it.
