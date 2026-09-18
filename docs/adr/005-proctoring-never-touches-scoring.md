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

Opt-in: face presence, head position and gaze from MediaPipe's face landmarker,
running on the candidate's device. Looking away from the screen spends a warning
like leaving the window does; being out of frame or having a second person in
shot is a note.

Always on, server side: the candidate's audio is forked to Deepgram's streaming
transcriber with diarization enabled, purely to count speakers. A second speaker
label is a note.

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
pointed into the eye. What the landmarker gives is iris position, and used raw it
is worth little: head rotation swamps it, and everyone's eyes sit differently
relative to their camera. A first attempt keyed on head rotation alone missed the
case that matters most, someone glancing at a phone while facing forward.

So the candidate looks at four points before the interview — centre, left, right,
and down where a phone would be — and the tracker records where their eyes and
head actually sit for each. At runtime a reading is classified as whichever
reference it is nearest. That makes eye movement detectable while the head stays
still, because the comparison is against this person's own poses rather than an
absolute angle.

Guards, because this now costs a warning:

* An off-screen reference must be 1.35x nearer than the on-screen one. A bare
  nearest-neighbour would flip on noise.
* The condition must hold five seconds. Everyone glances away mid-sentence.
* A calibration whose off-screen points barely differ from centre is discarded
  and the interview runs unproctored. Acting on noise is worse than not acting.

The output is a duration: "looked down, away from the screen for 11 seconds at
6:42". Never a percentage, never an attention rate, never a verdict.

## Signals deliberately not collected

Emotion, stress, attentiveness, speech rate, filler-word counts, and any
aggregate "suspicion score" or attention percentage. The same landmarks would
make several of these easy to compute. They are left out because they measure how
a person behaves rather than what they said, and they fall hardest on
neurodivergent and disabled candidates. None would improve a hiring decision.

Speaker diarization is not available on the Voice Agent socket -- `diarize` and
`multichannel` are both rejected on `agent.listen.provider`, verified against the
live API. It is available on the ordinary `/v1/listen` streaming endpoint, so the
audio is forked to a second connection whose only job is labelling speakers. A
second label is a note, never a conclusion: a television, a housemate and a
diarizer mistake are indistinguishable from there. Four words is the floor for a
label to count, and at most three notes are raised per interview.

No browser-side proctoring survives a phone propped beside the laptop. Anything
claiming to prevent cheating is overselling; these signals only narrow where a
human should look. The strongest check in this product is not in this file — it
is the agent asking an unscripted follow-up about the candidate's own claim.

## Consequences

The system detects less than it could. That is the intended trade.

The stronger anti-cheat is architectural anyway: an answer read off a second
screen collapses under an unscripted follow-up about the candidate's own claim.
`evals/personas.py` includes a bluffer to demonstrate it.
