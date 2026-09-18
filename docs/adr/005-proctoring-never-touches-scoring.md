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

Two sources, both in the candidate's browser.

Always on: leaving the interview window. Tab switches, another window taking
focus, and exiting full screen each spend one of three warnings; the third ends
the interview. Pastes, a second display, and a mid-interview audio device change
are recorded as notes and spend nothing.

Opt-in: face presence and head position from MediaPipe's face landmarker,
running on the candidate's device.

Ending an interview is not judging one. The scorecard records that it ended this
way; every decision about the candidate is still a person's.

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

## On gaze, and what "looking away" is allowed to mean

Retinal tracking is not possible from a webcam — it needs infrared hardware
pointed into the eye. What the landmarker does give is iris position, and from it
a gaze estimate carrying roughly 5-10 degrees of error uncalibrated, which is
wider than a laptop screen subtends. It cannot distinguish reading a second
monitor from glancing at the edge of this one.

So head rotation carries the signal and iris offset only corroborates it, both
measured against a baseline taken from the candidate's own first few seconds —
everyone sits at a different angle to their webcam, and an absolute threshold
would flag posture. Thresholds are wide (28 degrees of yaw) and an event must
persist six seconds. A false note on someone's hiring record is worse than a
missed one.

The output is a duration: "looked away for eleven seconds at 6:42". Never a
percentage, never a rate, never a verdict.

## Signals deliberately not collected

Emotion, stress, attentiveness, speech rate, filler-word counts, and any
aggregate "suspicion score" or attention percentage. The same landmarks would
make several of these easy to compute. They are left out because they measure how
a person behaves rather than what they said, and they fall hardest on
neurodivergent and disabled candidates. None would improve a hiring decision.

Speaker diarization was tried and is not available: Deepgram's Voice Agent
rejects `diarize` and `multichannel` on the listen provider, so a second person
feeding answers cannot be detected from the audio on this path. Rather than ship
a heuristic dressed up as detection, it is left out and said plainly here.

No browser-side proctoring survives a phone propped beside the laptop. Anything
claiming to prevent cheating is overselling; these signals only narrow where a
human should look. The strongest check in this product is not in this file — it
is the agent asking an unscripted follow-up about the candidate's own claim.

## Consequences

The system detects less than it could. That is the intended trade.

The stronger anti-cheat is architectural anyway: an answer read off a second
screen collapses under an unscripted follow-up about the candidate's own claim.
`evals/personas.py` includes a bluffer to demonstrate it.
