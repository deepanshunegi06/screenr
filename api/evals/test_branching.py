"""The claims these tests defend: this is an agent, and its guarantees hold.

They need a live LLM, so they skip without an API key. Cost per full run is a
fraction of a rupee on Groq's free tier -- no audio is involved.
"""

from __future__ import annotations

import os

import pytest

from evals import personas
from evals.runner import Run, run_interview

pytestmark = pytest.mark.skipif(
    not (os.getenv("GROQ_API_KEY") or os.getenv("GOOGLE_API_KEY") or os.getenv("ANTHROPIC_API_KEY")),
    reason="needs an LLM key",
)


@pytest.fixture(scope="module")
def strong() -> Run:
    return run_interview(personas.STRONG, max_turns=10)


@pytest.fixture(scope="module")
def bluffer() -> Run:
    return run_interview(personas.BLUFFER, max_turns=8)


def _failed(run: Run) -> str:
    return "\n".join(f"{c.name}: {c.detail}" for c in run.checks if not c.passed) + "\n" + run.pretty()


def test_bluffer_is_probed_more_than_strong_candidate(strong, bluffer):
    """The vague candidate should be dug into; the specific one should not."""
    assert bluffer.tool_sequence.count("plan_probe") > strong.tool_sequence.count("plan_probe"), _failed(
        bluffer
    )


def test_bluffer_does_not_outscore_specific_candidate(strong, bluffer):
    assert strong.scorecard["overall"] is not None
    assert bluffer.scorecard["overall"] is None or (
        strong.scorecard["overall"] > bluffer.scorecard["overall"]
    ), _failed(bluffer)


def test_strong_candidate_is_fully_covered_and_closed(strong):
    assert not strong.context.uncovered_skills(), _failed(strong)
    assert "end_interview" in strong.tool_sequence, _failed(strong)


@pytest.mark.parametrize("persona", personas.ALL, ids=lambda p: p.name)
def test_persona_expectations_hold(persona):
    run = run_interview(persona, max_turns=8)
    assert run.passed, _failed(run)
