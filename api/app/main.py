from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field

from . import store
from .auth import (
    candidate_session_id,
    current_recruiter,
    issue_candidate_token,
    issue_recruiter_token,
    verify_login,
)
from .config import get_settings
from .scoring import build_scorecard
from .relay import router as relay_router
from .usage import session_usage
from .voice import router as voice_router

app = FastAPI(
    title="screenr",
    description="First-round screening that gathers evidence and hands the decision to a person.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- recruiter ---------------------------------------------------------------


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    token: str


@app.get("/config")
def public_config() -> dict:
    """What the sign-in page needs before anyone has signed in.

    The password is only ever returned when demo_prefill is on, which is a
    deliberate convenience for a single-account demo -- never enable it anywhere
    real candidates or real candidate data can be reached.
    """
    s = get_settings()
    return {
        "demoPrefill": s.demo_prefill,
        "recruiterEmail": s.recruiter_email if s.demo_prefill else "",
        "recruiterPassword": s.recruiter_password if s.demo_prefill else "",
    }


@app.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest) -> TokenResponse:
    if not verify_login(body.email, body.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Those credentials don't match")
    return TokenResponse(token=issue_recruiter_token())


class InviteRequest(BaseModel):
    candidateEmail: EmailStr
    candidateName: str = ""
    rubric: str = "backend_intern"
    resumeText: str = ""


class InviteResponse(BaseModel):
    sessionId: str
    inviteToken: str
    candidateEmail: str


@app.post("/sessions", response_model=InviteResponse)
def create_session(body: InviteRequest, _: str = Depends(current_recruiter)) -> InviteResponse:
    """Invite a candidate. They get a link, not an account."""
    session = store.create(
        candidate_email=str(body.candidateEmail),
        candidate_name=body.candidateName,
        rubric=body.rubric,
        resume_text=body.resumeText,
    )
    return InviteResponse(
        sessionId=session.id,
        inviteToken=issue_candidate_token(session.id),
        candidateEmail=session.candidate_email,
    )


@app.get("/sessions")
def list_sessions(_: str = Depends(current_recruiter)) -> list[dict]:
    out = []
    for session in store.all_sessions():
        card = build_scorecard(session.ctx)
        out.append(
            {
                "id": session.id,
                "candidate": session.candidate_name,
                "roleTitle": session.ctx.role_title,
                "durationSeconds": card["duration_seconds"],
                "overall": card["overall"] if session.ctx.evidence else None,
                "confidence": card["confidence"],
                "recommendation": card["recommendation"],
                "started": session.started,
                "finished": session.ctx.is_finished(),
                "reviewed": session.decision is not None,
                "createdAt": session.created_at.isoformat(),
            }
        )
    return out


@app.get("/sessions/{session_id}")
async def get_scorecard(session_id: str, _: str = Depends(current_recruiter)) -> dict:
    session = _require(session_id)
    card = build_scorecard(session.ctx)
    card["candidate"] = session.candidate_name
    card["transcript"] = session.transcript
    card["decision"] = session.decision
    # Measured from Deepgram, not estimated from our own clock.
    card["usage"] = await session_usage(session.id)
    # Kept out of build_scorecard on purpose: see docs/adr/005.
    card["integrity"] = [
        {"kind": f.kind, "detail": f.detail, "at": 0} for f in session.ctx.flags
    ]
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
    return {"decision": session.decision, "decidedBy": recruiter}


# --- candidate ---------------------------------------------------------------


class ConsentRequest(BaseModel):
    token: str
    recordingConsent: bool
    proctoringConsent: bool = False


class TurnRequest(BaseModel):
    token: str
    answer: str


@app.get("/interview/{token}")
def interview_intro(token: str) -> dict:
    """What a candidate sees before consenting. No scores, ever."""
    session = _require(candidate_session_id(token))
    return {
        "candidate": session.candidate_name,
        "roleTitle": session.ctx.role_title,
        "maxMinutes": get_settings().max_interview_seconds // 60,
        "consented": session.consented,
        "started": session.started,
        "finished": session.ctx.is_finished(),
    }


@app.post("/interview/consent")
def give_consent(body: ConsentRequest) -> dict:
    session = _require(candidate_session_id(body.token))
    if not body.recordingConsent:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The interview needs recording consent")
    session.consented = True
    session.proctoring_consented = body.proctoringConsent
    return {"consented": True, "proctoring": session.proctoring_consented}


@app.post("/interview/start")
def start_interview(body: ConsentRequest) -> dict:
    session = _require(candidate_session_id(body.token))
    if not session.consented:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Consent is needed before starting")
    if session.started:
        last = next((t for t in reversed(session.transcript) if t["speaker"] == "agent"), None)
        return {"say": last["text"] if last else "", "finished": session.ctx.is_finished()}

    session.started = True
    # The clock starts when they start talking, not when the link was created.
    session.ctx.started_at = datetime.now(UTC)
    opening = session.agent.open()
    session.record("agent", opening, session.ctx.tool_log[-1] if session.ctx.tool_log else [])
    return {"say": opening, "finished": False}


@app.post("/interview/turn")
def take_turn(body: TurnRequest) -> dict:
    session = _require(candidate_session_id(body.token))
    if not session.started:
        raise HTTPException(status.HTTP_409_CONFLICT, "The interview hasn't started")

    session.record("candidate", body.answer)
    reply = session.agent.turn(body.answer)
    session.record("agent", reply, session.ctx.tool_log[-1] if session.ctx.tool_log else [])
    return {
        "say": reply,
        "finished": session.ctx.is_finished(),
        "elapsedSeconds": int(session.ctx.elapsed_seconds()),
    }


class IntegrityEvent(BaseModel):
    token: str
    kind: str
    detail: str


@app.post("/interview/integrity")
def report_integrity(body: IntegrityEvent) -> dict:
    """Browser-side integrity events. Stored next to the transcript for a human,
    never fed into scoring."""
    session = _require(candidate_session_id(body.token))
    store.add_integrity_flag(session, body.kind, body.detail)
    return {"recorded": True}


app.include_router(voice_router)
app.include_router(relay_router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


def _require(session_id: str) -> store.Session:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That interview link is no longer valid")
    return session
