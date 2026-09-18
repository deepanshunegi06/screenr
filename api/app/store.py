"""Where interviews live.

SQLite, stdlib, one table. Every mutation writes through, so a restart mid-interview
loses nothing: the candidate reconnects, Deepgram gets the history back from our
transcript, and the agent carries on with the evidence it already had.

An in-memory dict fronts the database so hot paths (a turn every few seconds) never
block on disk reads. Postgres would be the right call for a multi-instance
deployment; for an MVP on one box, this is the whole persistence layer.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .agent.graph import Interviewer
from .agent.state import Claim, Evidence, Flag, InterviewContext, Skill, StopReason
from .config import get_settings
from .roles import build_context

_DB_PATH = Path(get_settings().data_dir) / "screenr.db"
_LOCK = threading.Lock()

# A candidate controls how many integrity events their browser sends. Past this
# it is noise, or an attempt to bury something in it.
MAX_INTEGRITY_FLAGS = 200


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _from_iso(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


@dataclass
class Session:
    id: str
    candidate_email: str
    candidate_name: str
    rubric: str
    ctx: InterviewContext
    consented: bool = False
    started: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    transcript: list[dict] = field(default_factory=list)
    # Browser-side observations (tab switches and the like). Kept here, not on
    # ctx, so the scoring input structurally cannot contain them.
    integrity: list[Flag] = field(default_factory=list)
    decision: str | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    _agent: Interviewer | None = None

    @property
    def agent(self) -> Interviewer:
        """The typed-interview driver, built on first use.

        Voice interviews are driven by Deepgram and never touch this, so building
        it eagerly would make a text-LLM key a requirement for a voice-only
        deployment. Both drivers share the same context, so state is identical
        whichever one runs.
        """
        if self._agent is None:
            self._agent = Interviewer(self.ctx)
        return self._agent

    def duration_seconds(self) -> int:
        """Interview length. Zero before it starts, frozen once it ends -- never a
        counter that keeps climbing on an abandoned session."""
        if not self.started:
            return 0
        end = self.ended_at or datetime.now(UTC)
        return max(0, int((end - self.ctx.started_at).total_seconds()))

    def record(self, speaker: str, text: str, tools: list[str] | None = None) -> None:
        self.transcript.append(
            {
                "at": int(self.ctx.elapsed_seconds()),
                "speaker": speaker,
                "text": text,
                "tools": tools or [],
            }
        )
        save(self)

    # --- serialisation -----------------------------------------------------

    def to_row(self) -> dict:
        ctx = self.ctx
        return {
            "id": self.id,
            "candidate_email": self.candidate_email,
            "candidate_name": self.candidate_name,
            "rubric": self.rubric,
            "consented": self.consented,
            "started": self.started,
            "created_at": _iso(self.created_at),
            "ended_at": _iso(self.ended_at),
            "transcript": self.transcript,
            "integrity": [{**asdict(f), "at": _iso(f.at)} for f in self.integrity],
            "decision": self.decision,
            "decided_by": self.decided_by,
            "decided_at": _iso(self.decided_at),
            "ctx": {
                "role_title": ctx.role_title,
                "skills": [asdict(s) for s in ctx.skills],
                "claims": [asdict(c) for c in ctx.claims],
                "resume_text": ctx.resume_text,
                "evidence": [{**asdict(e), "at": _iso(e.at)} for e in ctx.evidence],
                "probes": ctx.probes,
                "flags": [{**asdict(f), "at": _iso(f.at)} for f in ctx.flags],
                "tool_log": ctx.tool_log,
                "asked": ctx.asked,
                "answers": ctx.answers,
                "turn_count": ctx.turn_count,
                "last_evidence_turn": ctx.last_evidence_turn,
                "stop_reason": ctx.stop_reason,
                "escalation_note": ctx.escalation_note,
                "started_at": _iso(ctx.started_at),
            },
        }

    @classmethod
    def from_row(cls, row: dict) -> Session:
        c = row["ctx"]
        ctx = InterviewContext(
            session_id=row["id"],
            role_title=c["role_title"],
            skills=[Skill(**s) for s in c["skills"]],
            claims=[Claim(**k) for k in c["claims"]],
            resume_text=c.get("resume_text", ""),
            evidence=[Evidence(**{**e, "at": _from_iso(e["at"])}) for e in c.get("evidence", [])],
            probes=c.get("probes", {}),
            flags=[Flag(**{**f, "at": _from_iso(f["at"])}) for f in c.get("flags", [])],
            tool_log=c.get("tool_log", []),
            asked=c.get("asked", []),
            answers=c.get("answers", []),
            turn_count=c.get("turn_count", 0),
            last_evidence_turn=c.get("last_evidence_turn", 0),
            stop_reason=c.get("stop_reason"),
            escalation_note=c.get("escalation_note"),
            started_at=_from_iso(c["started_at"]),
        )
        return cls(
            id=row["id"],
            candidate_email=row["candidate_email"],
            candidate_name=row["candidate_name"],
            rubric=row["rubric"],
            ctx=ctx,
            consented=row.get("consented", False),
            started=row.get("started", False),
            created_at=_from_iso(row["created_at"]),
            ended_at=_from_iso(row.get("ended_at")),
            transcript=row.get("transcript", []),
            integrity=[Flag(**{**f, "at": _from_iso(f["at"])}) for f in row.get("integrity", [])],
            decision=row.get("decision"),
            decided_by=row.get("decided_by"),
            decided_at=_from_iso(row.get("decided_at")),
        )


# --- database ------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            created_at  TEXT NOT NULL,
            body        TEXT NOT NULL
        )
        """
    )
    return conn


_CONN = _connect()
_SESSIONS: dict[str, Session] = {}


def _load_all() -> None:
    rows = _CONN.execute("SELECT body FROM sessions ORDER BY created_at").fetchall()
    for (body,) in rows:
        try:
            session = Session.from_row(json.loads(body))
        except (KeyError, ValueError, TypeError):
            # A row from an older schema is not worth crashing startup over.
            continue
        _SESSIONS[session.id] = session


_load_all()


def save(session: Session) -> None:
    body = json.dumps(session.to_row(), ensure_ascii=False)
    with _LOCK:
        _CONN.execute(
            "INSERT INTO sessions (id, created_at, body) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            (session.id, session.created_at.isoformat(), body),
        )
        _CONN.commit()


# --- api -----------------------------------------------------------------------


def create(candidate_email: str, candidate_name: str, rubric: str, resume_text: str = "") -> Session:
    session_id = f"s-{uuid.uuid4().hex[:8]}"
    ctx = build_context(rubric, resume_text=resume_text, session_id=session_id)
    session = Session(
        id=session_id,
        candidate_email=candidate_email.strip().lower(),
        candidate_name=candidate_name.strip() or candidate_email.split("@")[0],
        rubric=rubric,
        ctx=ctx,
    )
    _SESSIONS[session_id] = session
    save(session)
    return session


def get(session_id: str) -> Session | None:
    return _SESSIONS.get(session_id)


def all_sessions() -> list[Session]:
    return sorted(_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)


def delete(session_id: str) -> bool:
    session = _SESSIONS.pop(session_id, None)
    if session is None:
        return False
    with _LOCK:
        _CONN.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        _CONN.commit()
    return True


def start(session: Session) -> None:
    """The clock starts when the candidate arrives, not when the link was made."""
    if not session.started:
        session.started = True
        session.ctx.started_at = datetime.now(UTC)
        save(session)


def finish(session: Session, reason: StopReason | None = None) -> None:
    """Freeze the interview. Idempotent: the first caller's reason wins."""
    if session.ctx.stop_reason is None:
        session.ctx.stop_reason = reason or "incomplete"
    if session.ended_at is None:
        session.ended_at = datetime.now(UTC)
    save(session)


def add_integrity_flag(session: Session, kind: str, detail: str) -> None:
    """Integrity events live on the session, never on the scorecard.
    See docs/adr/005-proctoring-never-touches-scoring.md."""
    if len(session.integrity) >= MAX_INTEGRITY_FLAGS:
        return
    session.integrity.append(Flag(kind=kind, detail=detail[:200]))
    save(session)
