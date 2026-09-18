"""Scorecard arithmetic and claim extraction. No LLM, no network, no keys."""

from __future__ import annotations

from app.agent.state import Evidence, InterviewContext, Skill
from app.roles import extract_claims
from app.scoring import build_scorecard


def ctx_with(evidence: list[Evidence]) -> InterviewContext:
    return InterviewContext(
        session_id="t",
        role_title="Backend intern",
        skills=[
            Skill("a", "A", "specifics", weight=1.0),
            Skill("b", "B", "specifics", weight=1.0),
            Skill("c", "C", "specifics", weight=0.5),
        ],
        evidence=evidence,
    )


def ev(skill: str, score: float) -> Evidence:
    return Evidence(skill_key=skill, score=score, quote="they said a thing", note="")


def test_uncovered_skill_scores_none_not_zero():
    card = build_scorecard(ctx_with([ev("a", 4)]))
    by_key = {s["key"]: s for s in card["skills"]}
    assert by_key["a"]["score"] == 4
    assert by_key["b"]["score"] is None
    assert by_key["b"]["covered"] is False


def test_overall_is_weighted():
    card = build_scorecard(ctx_with([ev("a", 4), ev("b", 4), ev("c", 1)]))
    # (4 + 4 + 0.5) / 2.5 = 3.4
    assert card["overall"] == 3.4


def test_repeat_evidence_averages():
    card = build_scorecard(ctx_with([ev("a", 2), ev("a", 4)]))
    assert next(s for s in card["skills"] if s["key"] == "a")["score"] == 3.0


def test_low_coverage_forces_inconclusive():
    card = build_scorecard(ctx_with([ev("a", 5)]))
    assert card["confidence"] == "low"
    assert card["recommendation"] == "inconclusive"


def test_escalation_overrides_a_good_score():
    ctx = ctx_with([ev("a", 5), ev("b", 5), ev("c", 5), ev("a", 5)])
    ctx.stop_reason = "escalated"
    card = build_scorecard(ctx)
    assert card["overall"] == 5.0
    assert card["recommendation"] == "inconclusive"


def test_scorecard_never_says_reject():
    for score in (1, 2, 3, 4, 5):
        ctx = ctx_with([ev("a", score), ev("b", score), ev("c", score), ev("a", score)])
        assert build_scorecard(ctx)["recommendation"] in {
            "advance",
            "another_round",
            "inconclusive",
        }


def test_claims_come_from_action_lines_only():
    resume = """Priya Sharma -- B.Tech CSE, 2026

Built a flight delay predictor serving 500 requests a day on a free tier VM.
Interests: cricket, photography
Deployed the whole stack with docker compose and a github actions pipeline.
b.tech
"""
    claims = extract_claims(resume)
    assert len(claims) == 2
    assert all(("Built" in c or "Deployed" in c) for c in claims)
    assert not any("cricket" in c for c in claims)
