from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field

from . import store
from .auth import (
    candidate_session_id,
    check_configuration,
    current_recruiter,
    issue_candidate_token,
    issue_recruiter_token,
    verify_login,
)
from .config import get_settings
from .relay import router as relay_router
from .roles import list_rubrics, load_rubric
from .scoring import build_scorecard
from .usage import session_usage

check_configuration()

app = FastAPI(
    title="screenr",
    description="First-round screening that gathers evidence and hands the decision to a person.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(relay_router)

EVALS_RESULTS = Path(__file__).resolve().parent.parent / "evals" / "results" / "latest.json"


# --- auth ------------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


class TokenResponse(BaseModel):
    token: str


@app.get("/config")
def public_config() -> dict:
    return {"demoMode": get_settings().demo_mode}


@app.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest) -> TokenResponse:
    if not verify_login(body.email, body.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Those credentials don't match")
    return TokenResponse(token=issue_recruiter_token())


@app.post("/auth/demo", response_model=TokenResponse)
def demo_login() -> TokenResponse:
    """One-click sign-in for demos. The password is never sent anywhere; this
    mints a token directly, and only when the deployment opts in."""
    if not get_settings().demo_mode:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Demo sign-in is not enabled")
    return TokenResponse(token=issue_recruiter_token())


# --- recruiter: sessions -----------------------------------------------------------


class InviteRequest(BaseModel):
    candidateEmail: EmailStr
    candidateName: str = Field("", max_length=80)
    rubric: str = Field("backend_intern", pattern=r"^[a-z0-9_]{1,40}$")
    resumeText: str = Field("", max_length=20000)


class InviteResponse(BaseModel):
    sessionId: str
    inviteToken: str
    candidateEmail: str


def _row(session: store.Session) -> dict:
    card = build_scorecard(session.ctx)
    regular = [s for s in session.ctx.skills if not s.cross_cutting]
    return {
        "id": session.id,
        "candidate": session.candidate_name,
        "candidateEmail": session.candidate_email,
        "roleTitle": session.ctx.role_title,
        "rubric": session.rubric,
        "durationSeconds": session.duration_seconds(),
        "turns": session.ctx.turn_count,
        "skillsCovered": len(regular) - len(session.ctx.uncovered_skills()),
        "skillsTotal": len(regular),
        "overall": card["overall"],
        "confidence": card["confidence"],
        "recommendation": card["recommendation"],
        "started": session.started,
        "finished": session.ctx.is_finished(),
        "reviewed": session.decision is not None,
        "decision": session.decision,
        "createdAt": session.created_at.isoformat(),
    }


@app.post("/sessions", response_model=InviteResponse)
def create_session(body: InviteRequest, _: str = Depends(current_recruiter)) -> InviteResponse:
    """Invite a candidate. They get a link, not an account."""
    try:
        session = store.create(
            candidate_email=str(body.candidateEmail),
            candidate_name=body.candidateName,
            rubric=body.rubric,
            resume_text=body.resumeText,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return InviteResponse(
        sessionId=session.id,
        inviteToken=issue_candidate_token(session.id),
        candidateEmail=session.candidate_email,
    )


@app.get("/sessions")
def list_sessions(_: str = Depends(current_recruiter)) -> list[dict]:
    return [_row(s) for s in store.all_sessions()]


@app.get("/sessions/{session_id}")
async def get_scorecard(session_id: str, _: str = Depends(current_recruiter)) -> dict:
    session = _require(session_id)
    card = build_scorecard(session.ctx)
    card["candidate"] = session.candidate_name
    card["candidateEmail"] = session.candidate_email
    card["duration_seconds"] = session.duration_seconds()
    card["transcript"] = session.transcript
    card["decision"] = session.decision
    card["decidedBy"] = session.decided_by
    card["decidedAt"] = session.decided_at.isoformat() if session.decided_at else None
    card["createdAt"] = session.created_at.isoformat()
    card["startedAt"] = session.ctx.started_at.isoformat() if session.started else None
    card["finished"] = session.ctx.is_finished()
    # Kept off the scorecard input on purpose: see docs/adr/005.
    card["integrity"] = [
        {
            "kind": f.kind,
            "detail": f.detail,
            "at": max(0, int((f.at - session.ctx.started_at).total_seconds())),
        }
        for f in session.integrity
    ]
    # Measured from Deepgram, not estimated from our own clock; null when unknown.
    card["usage"] = await session_usage(session.id)
    return card


class DecisionRequest(BaseModel):
    decision: str = Field(pattern="^(advance|another_round|reject)$")


@app.post("/sessions/{session_id}/decision")
def record_decision(
    session_id: str, body: DecisionRequest, recruiter: str = Depends(current_recruiter)
) -> dict:
    """The only place a hiring outcome is ever written, and it takes a human."""
    session = _require(session_id)
    session.decision = body.decision
    session.decided_by = recruiter
    session.decided_at = datetime.now(UTC)
    store.save(session)
    return {"decision": session.decision, "decidedBy": recruiter}


@app.post("/sessions/{session_id}/close")
def close_session(session_id: str, _: str = Depends(current_recruiter)) -> dict:
    """Mark an abandoned interview as over so it stops counting up."""
    session = _require(session_id)
    store.finish(session, "incomplete")
    return {"closed": True}


@app.get("/sessions/{session_id}/invite")
def reissue_invite(session_id: str, _: str = Depends(current_recruiter)) -> dict:
    """A fresh candidate link for a session that already exists."""
    session = _require(session_id)
    return {"inviteToken": issue_candidate_token(session.id), "sessionId": session.id}


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str, _: str = Depends(current_recruiter)) -> dict:
    if not store.delete(session_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return {"deleted": session_id}


# --- recruiter: roles and evals ------------------------------------------------------


@app.get("/roles")
def roles(_: str = Depends(current_recruiter)) -> list[dict]:
    out = []
    for key in list_rubrics():
        title, skills = load_rubric(key)
        out.append(
            {
                "key": key,
                "title": title,
                "skills": [
                    {
                        "key": s.key,
                        "name": s.name,
                        "weight": s.weight,
                        "cross_cutting": s.cross_cutting,
                        "what_good_looks_like": s.what_good_looks_like,
                    }
                    for s in skills
                ],
            }
        )
    return out


@app.get("/evals")
def evals(_: str = Depends(current_recruiter)) -> dict:
    """Committed eval results. Runs happen offline via `python -m app.cli --json`."""
    if EVALS_RESULTS.is_file():
        try:
            return json.loads(EVALS_RESULTS.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {
        "ranAt": None,
        "model": "",
        "provider": "",
        "runs": [],
        "summary": {"total": 0, "passed": 0, "branchingProven": False},
    }


# --- candidate ---------------------------------------------------------------------


class ConsentRequest(BaseModel):
    token: str
    recordingConsent: bool
    # Separate and optional: camera checks are declinable and the interview runs
    # either way. See docs/adr/005-proctoring-never-touches-scoring.md.
    proctoringConsent: bool = False


@app.get("/interview/{token}")
def interview_intro(token: str) -> dict:
    """What a candidate sees before consenting. No scores, ever."""
    session = _require_candidate(token)
    return {
        "candidate": session.candidate_name,
        "roleTitle": session.ctx.role_title,
        "maxMinutes": get_settings().max_interview_seconds // 60,
        "consented": session.consented,
        "proctoringConsented": session.proctoring_consented,
        "started": session.started,
        "finished": session.ctx.is_finished(),
    }


@app.post("/interview/consent")
def give_consent(body: ConsentRequest) -> dict:
    session = _require_candidate(body.token)
    if not body.recordingConsent:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The interview needs recording consent")
    session.consented = True
    session.proctoring_consented = body.proctoringConsent
    store.save(session)
    return {"consented": True, "proctoring": session.proctoring_consented}


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


def _require(session_id: str) -> store.Session:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return session


def _require_candidate(token: str) -> store.Session:
    session = store.get(candidate_session_id(token))
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That interview link is no longer valid")
    return session
