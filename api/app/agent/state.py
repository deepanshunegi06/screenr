"""Interview state.

Two things are deliberately kept apart:

* ``InterviewState`` -- the LangGraph channel, holding only the message history.
  The typed driver checkpoints this in memory so the model sees its own previous
  questions; the voice driver keeps history on Deepgram's side and replays it
  from our transcript on reconnect.
* ``InterviewContext`` -- the facts about *this* candidate and what the agent has
  concluded so far. Tools read and mutate it. It is plain Python so the whole
  agent can run in tests with no database, and it serialises to JSON so an
  interview survives a restart.
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
    # Scored once from the whole conversation rather than asked about directly
    # (communication, for instance). Excluded from coverage until the end.
    cross_cutting: bool = False


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
    # Seconds into the interview. Anchors the score to the transcript and places
    # it on the coverage map.
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
    # The candidate's resume, verbatim. It goes into the prompt as fenced data so
    # the model can check claims against it without a retrieval round-trip.
    resume_text: str = ""

    evidence: list[Evidence] = field(default_factory=list)
    probes: dict[str, int] = field(default_factory=dict)
    # Only escalation flags live here. Proctoring/integrity events are kept on the
    # session, structurally outside anything scoring can read.
    flags: list[Flag] = field(default_factory=list)
    # Ordered record of which tools the model chose, per turn. This is the
    # evidence that the agent branches at runtime rather than following a script.
    tool_log: list[list[str]] = field(default_factory=list)
    # Everything the agent has asked and everything the candidate has answered.
    # Fed back into the prompt so it can see itself repeating, and used to check
    # that recorded quotes are words the candidate actually said.
    asked: list[str] = field(default_factory=list)
    answers: list[str] = field(default_factory=list)
    turn_count: int = 0
    last_evidence_turn: int = 0
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
        """Skills the interview still has to reach. Cross-cutting skills are
        scored at the end from the whole conversation, so they never block."""
        covered = self.scores().keys()
        return [s for s in self.skills if s.key not in covered and not s.cross_cutting]

    def unscored_cross_cutting(self) -> list[Skill]:
        covered = self.scores().keys()
        return [s for s in self.skills if s.cross_cutting and s.key not in covered]

    def unverified_claims(self) -> list[Claim]:
        return [c for c in self.claims if c.status == "unverified"]

    def elapsed_seconds(self) -> float:
        return (datetime.now(UTC) - self.started_at).total_seconds()

    def is_finished(self) -> bool:
        return self.stop_reason is not None

    def is_escalated(self) -> bool:
        return any(f.kind == "escalation" for f in self.flags)
