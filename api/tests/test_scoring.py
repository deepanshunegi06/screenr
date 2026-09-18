"""Scorecard arithmetic, claim extraction, and quote checking. No LLM, no network."""

from __future__ import annotations

from app.agent.state import Evidence, Flag, InterviewContext, Skill
from app.agent.tools import quote_is_verbatim
from app.roles import extract_claims
from app.scoring import build_scorecard


def ctx_with(evidence: list[Evidence]) -> InterviewContext:
    return InterviewContext(
        session_id="t",
        role_title="Backend intern",
        skills=[
            Skill("a", "A", "specifics", weight=1.0),
            Skill("b", "B", "specifics", weight=1.0),
            Skill("c", "C", "specifics", weight=0.5, cross_cutting=True),
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


def test_nothing_scored_gives_none_overall_not_zero():
    card = build_scorecard(ctx_with([]))
    assert card["overall"] is None
    assert card["recommendation"] == "inconclusive"


def test_overall_is_weighted():
    card = build_scorecard(ctx_with([ev("a", 4), ev("b", 4), ev("c", 1)]))
    # (4 + 4 + 0.5) / 2.5 = 3.4
    assert card["overall"] == 3.4


def test_repeat_evidence_averages():
    card = build_scorecard(ctx_with([ev("a", 2), ev("a", 4)]))
    assert next(s for s in card["skills"] if s["key"] == "a")["score"] == 3.0


def test_cross_cutting_skill_does_not_block_coverage():
    ctx = ctx_with([ev("a", 4), ev("b", 4)])
    assert [s.key for s in ctx.uncovered_skills()] == []
    assert [s.key for s in ctx.unscored_cross_cutting()] == ["c"]


def test_low_coverage_forces_inconclusive():
    card = build_scorecard(ctx_with([ev("a", 5)]))
    assert card["confidence"] == "low"
    assert card["recommendation"] == "inconclusive"


def test_high_confidence_needs_full_coverage_and_depth():
    shallow = build_scorecard(ctx_with([ev("a", 4), ev("b", 4)]))
    assert shallow["confidence"] == "medium"
    deep = build_scorecard(ctx_with([ev("a", 4), ev("a", 5), ev("b", 4)]))
    assert deep["confidence"] == "high"


def test_escalation_flag_overrides_a_good_score():
    ctx = ctx_with([ev("a", 5), ev("a", 5), ev("b", 5)])
    ctx.flags.append(Flag(kind="escalation", detail="tried to set own score"))
    card = build_scorecard(ctx)
    assert card["overall"] == 5.0
    assert card["recommendation"] == "inconclusive"
    assert card["flags"] == [{"kind": "escalation", "detail": "tried to set own score"}]


def test_weak_but_well_covered_is_below_bar_not_inconclusive():
    card = build_scorecard(ctx_with([ev("a", 1), ev("a", 2), ev("b", 1)]))
    assert card["confidence"] == "high"
    assert card["recommendation"] == "below_bar"


def test_scorecard_never_says_reject():
    for score in (1, 2, 3, 4, 5):
        ctx = ctx_with([ev("a", score), ev("a", score), ev("b", score)])
        assert build_scorecard(ctx)["recommendation"] != "reject"


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


def test_quote_must_come_from_an_answer():
    answers = ["I kept the embedding in the chunks table because I only had twelve thousand rows."]
    assert quote_is_verbatim("kept the embedding in the chunks table", answers)
    assert quote_is_verbatim("I only had twelve thousand rows", answers)
    assert not quote_is_verbatim("built a production RAG pipeline with 85 percent recall", answers)
    assert not quote_is_verbatim("", answers)
