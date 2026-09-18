"""Interview state.

Two things are deliberately kept apart:

* ``InterviewState`` -- the LangGraph channel, holding only the message history.
  LangGraph checkpoints this, which is what makes an interview resumable after a
  dropped connection.
* ``InterviewContext`` -- the facts about *this* candidate and what the agent has
  concluded so far. Tools read and mutate it. It is plain Python so the whole
  agent can run in tests with no database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Literal, TypedDict

from langgraph.graph.message import add_messages

ClaimStatus = Literal["unverified", "verified", "refuted"]
StopReason = Literal[
    "sufficient_evidence",
    "question_bank_exhausted",
    "duration_cap",
    "turn_cap",
    "candidate_ended",
    "escalated",
    "incomplete",
]


class InterviewState(TypedDict):
    messages: Annotated[list, add_messages]


@dataclass
class Skill:
    key: str
    name: str
    what_good_looks_like: str
    weight: float = 1.0


@dataclass
class Claim:
    id: str
    text: str
    status: ClaimStatus = "unverified"
    note: str = ""


@dataclass
class Evidence:
    skill_key: str
    score: float
    quote: str
    note: str
    # Seconds into the interview. This is what anchors a score to the transcript,
    # and what the coverage map is plotted against.
    at_seconds: float = 0.0
    at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class Flag:
    kind: str
    detail: str
    at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class InterviewContext:
    session_id: str
    role_title: str
    skills: list[Skill]
    claims: list[Claim] = field(default_factory=list)
    resume_chunks: list[str] = field(default_factory=list)

    evidence: list[Evidence] = field(default_factory=list)
    probes: dict[str, int] = field(default_factory=dict)
    flags: list[Flag] = field(default_factory=list)
    # Ordered record of which tools the model chose, per turn. This is the
    # evidence that the agent branches at runtime rather than following a script.
    tool_log: list[list[str]] = field(default_factory=list)
    turn_count: int = 0
    stop_reason: StopReason | None = None
    escalation_note: str | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    # --- derived views the agent's prompt is built from -------------------

    def skill(self, key: str) -> Skill | None:
        return next((s for s in self.skills if s.key == key), None)

    def scores(self) -> dict[str, float]:
        """Mean score per skill. A skill with no evidence is absent, not zero --
        'we never got to it' and 'they were bad at it' are different findings."""
        by_skill: dict[str, list[float]] = {}
        for e in self.evidence:
            by_skill.setdefault(e.skill_key, []).append(e.score)
        return {k: round(sum(v) / len(v), 2) for k, v in by_skill.items()}

    def uncovered_skills(self) -> list[Skill]:
        covered = self.scores().keys()
        return [s for s in self.skills if s.key not in covered]

    def unverified_claims(self) -> list[Claim]:
        return [c for c in self.claims if c.status == "unverified"]

    def elapsed_seconds(self) -> float:
        return (datetime.now(UTC) - self.started_at).total_seconds()

    def probe_budget_left(self, topic: str, cap: int) -> int:
        return max(0, cap - self.probes.get(topic, 0))

    def is_finished(self) -> bool:
        return self.stop_reason is not None
