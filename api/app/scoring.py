"""Scorecard assembly.

Deliberately dumb arithmetic over the evidence the agent recorded. The model does
not get to invent a final verdict -- it produces evidence, and this file adds it
up in a way a recruiter can re-check by hand.

The input is an ``InterviewContext``, which structurally cannot contain proctoring
or integrity events -- those live on the session. See
docs/adr/005-proctoring-never-touches-scoring.md.
"""

from __future__ import annotations

from typing import Literal

from .agent.state import InterviewContext

Confidence = Literal["high", "medium", "low"]

# There is no 'reject' here and never will be. 'below_bar' is a recommendation a
# human can overrule; only a human records a rejection.
Recommendation = Literal["advance", "another_round", "below_bar", "inconclusive"]

ADVANCE_THRESHOLD = 3.5
ANOTHER_ROUND_THRESHOLD = 2.5


def _confidence(ctx: InterviewContext) -> Confidence:
    regular = [s for s in ctx.skills if not s.cross_cutting]
    uncovered = len(ctx.uncovered_skills())
    covered = len(regular) - uncovered
    scores = ctx.scores()
    # Depth: did any skill get a second look, or was every score a single answer?
    depth = max((sum(1 for e in ctx.evidence if e.skill_key == k) for k in scores), default=0)
    if uncovered == 0 and depth >= 2:
        return "high"
    if uncovered <= 1 and covered >= 2:
        return "medium"
    return "low"


def build_scorecard(ctx: InterviewContext) -> dict:
    scores = ctx.scores()

    scored = [(ctx.skill(k), v) for k, v in scores.items()]
    scored = [(s, v) for s, v in scored if s is not None]
    total_weight = sum(s.weight for s, _ in scored)
    overall = round(sum(v * s.weight for s, v in scored) / total_weight, 2) if scored else None

    confidence = _confidence(ctx)

    if ctx.is_escalated() or confidence == "low" or overall is None:
        recommendation: Recommendation = "inconclusive"
    elif overall >= ADVANCE_THRESHOLD:
        recommendation = "advance"
    elif overall >= ANOTHER_ROUND_THRESHOLD:
        recommendation = "another_round"
    else:
        recommendation = "below_bar"

    return {
        "session_id": ctx.session_id,
        "role_title": ctx.role_title,
        "overall": overall,
        "confidence": confidence,
        # A recommendation, not a decision. No code path acts on this value.
        "recommendation": recommendation,
        "stop_reason": ctx.stop_reason,
        "escalation_note": ctx.escalation_note,
        "duration_seconds": int(ctx.elapsed_seconds()),
        "turns": ctx.turn_count,
        "skills": [
            {
                "key": s.key,
                "name": s.name,
                "weight": s.weight,
                "cross_cutting": s.cross_cutting,
                "score": scores.get(s.key),
                "covered": s.key in scores,
                "evidence": [
                    {
                        "quote": e.quote,
                        "note": e.note,
                        "score": e.score,
                        "at": int(e.at_seconds),
                    }
                    for e in ctx.evidence
                    if e.skill_key == s.key
                ],
            }
            for s in ctx.skills
        ],
        "claims": [{"id": c.id, "text": c.text, "status": c.status, "note": c.note} for c in ctx.claims],
        "flags": [{"kind": f.kind, "detail": f.detail} for f in ctx.flags if f.kind == "escalation"],
    }
