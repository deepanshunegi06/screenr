"""Where live interviews are kept.

# ponytail: in-memory, single process. Interviews do not survive a restart yet.
# The replacement is the LangGraph Postgres checkpointer for the message history
# plus a sessions table for the context -- both are already shaped for it, since
# InterviewContext is a plain dataclass and the graph already takes a
# checkpointer argument. Swap when DATABASE_URL is configured.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .agent.graph import Interviewer
from .agent.state import Flag, InterviewContext
from .roles import build_context


@dataclass
class Session:
    id: str
    candidate_email: str
    candidate_name: str
    rubric: str
    ctx: InterviewContext
    agent: Interviewer
    consented: bool = False
    proctoring_consented: bool = False
    started: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    transcript: list[dict] = field(default_factory=list)
    decision: str | None = None
    decided_by: str | None = None

    def record(self, speaker: str, text: str, tools: list[str] | None = None) -> None:
        self.transcript.append(
            {
                "at": int(self.ctx.elapsed_seconds()),
                "speaker": speaker,
                "text": text,
                "tools": tools or [],
            }
        )


_SESSIONS: dict[str, Session] = {}


def create(candidate_email: str, candidate_name: str, rubric: str, resume_text: str = "") -> Session:
    session_id = f"s-{uuid.uuid4().hex[:8]}"
    ctx = build_context(rubric, resume_text=resume_text, session_id=session_id)
    session = Session(
        id=session_id,
        candidate_email=candidate_email.strip().lower(),
        candidate_name=candidate_name.strip() or candidate_email.split("@")[0],
        rubric=rubric,
        ctx=ctx,
        agent=Interviewer(ctx),
    )
    _SESSIONS[session_id] = session
    return session


def get(session_id: str) -> Session | None:
    return _SESSIONS.get(session_id)


def all_sessions() -> list[Session]:
    return sorted(_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)


def add_integrity_flag(session: Session, kind: str, detail: str) -> None:
    """Integrity events live on the session, never on the scorecard.
    See docs/adr/005-proctoring-never-touches-scoring.md."""
    session.ctx.flags.append(Flag(kind=kind, detail=detail))
