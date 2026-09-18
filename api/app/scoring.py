"""Scorecard assembly.

Deliberately dumb arithmetic over the evidence the agent recorded. The model does
not get to invent a final verdict -- it produces evidence, and this file adds it
up in a way a recruiter can re-check by hand.

Nothing here reads proctoring flags. Integrity signals and capability scores are
kept apart on purpose: see docs/adr/005-proctoring-boundary.md.
"""

from __future__ import annotations

from typing import Literal

from .agent.state import InterviewContext

Confidence = Literal["high", "medium", "low"]
Recommendation = Literal["advance", "another_round", "inconclusive"]

ADVANCE_THRESHOLD = 3.5
ANOTHER_ROUND_THRESHOLD = 2.5


def _confidence(ctx: InterviewContext) -> Confidence:
    uncovered = len(ctx.uncovered_skills())
    if uncovered == 0 and len(ctx.evidence) >= len(ctx.skills) + 1:
        return "high"
    if uncovered <= 1:
        return "medium"
    return "low"


def build_scorecard(ctx: InterviewContext) -> dict:
    scores = ctx.scores()

    scored = [(ctx.skill(k), v) for k, v in scores.items()]
    total_weight = sum(s.weight for s, _ in scored if s) or 1.0
    overall = sum(v * s.weight for s, v in scored if s) / total_weight if scored else 0.0

    confidence = _confidence(ctx)

    if ctx.stop_reason == "escalated" or confidence == "low":
        recommendation: Recommendation = "inconclusive"
    elif overall >= ADVANCE_THRESHOLD:
        recommendation = "advance"
    elif overall >= ANOTHER_ROUND_THRESHOLD:
        recommendation = "another_round"
    else:
        recommendation = "inconclusive"

    return {
        "session_id": ctx.session_id,
        "role_title": ctx.role_title,
        "overall": round(overall, 2),
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
                "score": scores.get(s.key),
                "covered": s.key in scores,
                "evidence": [
                    {"quote": e.quote, "note": e.note, "score": e.score}
                    for e in ctx.evidence
                    if e.skill_key == s.key
                ],
            }
            for s in ctx.skills
        ],
        "claims": [
            {"id": c.id, "text": c.text, "status": c.status, "note": c.note} for c in ctx.claims
        ],
        "flags": [{"kind": f.kind, "detail": f.detail} for f in ctx.flags],
    }
