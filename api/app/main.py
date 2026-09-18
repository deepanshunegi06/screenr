from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, EmailStr, Field, TypeAdapter, ValidationError

from . import evalruns, store
from .auth import (
    candidate_session_id,
    check_configuration,
    current_recruiter,
    issue_candidate_token,
    issue_recruiter_token,
    recruiter_from_query,
    verify_login,
)
from .config import get_settings
from .relay import router as relay_router
from .resumes import extract, guess_name
from .roledraft import draft_rubric
from .roles import (
    delete_rubric,
    is_builtin,
    list_rubrics,
    load_rubric,
    save_rubric,
    slugify,
)
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


@app.post("/resumes/parse")
async def parse_resume(
    file: UploadFile = File(...), _: str = Depends(current_recruiter)
) -> dict:
    """Text out of a PDF or Word résumé. The file itself is never stored."""
    try:
        text = extract(file.filename or "", await file.read())
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"text": text, "name": guess_name(text), "characters": len(text)}


class BulkInviteRow(BaseModel):
    """A row of a pasted shortlist.

    The address is a plain string on purpose: typed as EmailStr, one typo in row
    fourteen would 422 the whole batch, which is the opposite of what this
    endpoint promises. It is validated per row instead, below.
    """

    candidateEmail: str = Field(max_length=254)
    candidateName: str = Field("", max_length=80)
    rubric: str = Field("backend_intern", pattern=r"^[a-z0-9_]{1,40}$")
    resumeText: str = Field("", max_length=20000)


class BulkInviteRequest(BaseModel):
    candidates: list[BulkInviteRow] = Field(min_length=1, max_length=100)


_EMAIL = TypeAdapter(EmailStr)


@app.post("/sessions/bulk")
def create_sessions(body: BulkInviteRequest, _: str = Depends(current_recruiter)) -> dict:
    """Invite a whole shortlist at once.

    One bad row does not lose the rest: each result carries either a link or the
    reason it failed, so the recruiter can fix two addresses rather than redo
    thirty.
    """
    created: list[dict] = []
    failed: list[dict] = []
    for candidate in body.candidates:
        try:
            _EMAIL.validate_python(candidate.candidateEmail)
        except ValidationError:
            failed.append({"candidateEmail": candidate.candidateEmail, "reason": "Not an email address."})
            continue
        try:
            session = store.create(
                candidate_email=str(candidate.candidateEmail),
                candidate_name=candidate.candidateName,
                rubric=candidate.rubric,
                resume_text=candidate.resumeText,
            )
        except ValueError as exc:
            failed.append({"candidateEmail": str(candidate.candidateEmail), "reason": str(exc)})
            continue
        created.append(
            {
                "sessionId": session.id,
                "candidateEmail": session.candidate_email,
                "candidateName": session.candidate_name,
                "inviteToken": issue_candidate_token(session.id),
            }
        )
    return {"created": created, "failed": failed}


@app.get("/sessions/{session_id}/evidence/{name}")
def evidence(session_id: str, name: str, _: str = Depends(recruiter_from_query)) -> FileResponse:
    """The camera frame taken when a warning fired.

    "The system glitched" is a hard argument to have without one, and an easy
    one to settle with it.
    """
    path = store.evidence_path(session_id, name)
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such frame")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/sessions")
def list_sessions(_: str = Depends(current_recruiter)) -> list[dict]:
    return [_row(s) for s in store.all_sessions()]


@app.get("/compare")
def compare(rubric: str, _: str = Depends(current_recruiter)) -> dict:
    """Every finished candidate for one role, against the same skills.

    The recruiter's actual job is not reading one scorecard, it is choosing
    between eight. Same rubric, same columns, so the comparison is like for like.
    """
    try:
        title, skills = load_rubric(rubric)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    rows = []
    for session in store.all_sessions():
        if session.rubric != rubric or not session.started:
            continue
        card = build_scorecard(session.ctx)
        scores = {s["key"]: s["score"] for s in card["skills"]}
        rows.append(
            {
                "id": session.id,
                "candidate": session.candidate_name,
                "candidateEmail": session.candidate_email,
                "overall": card["overall"],
                "confidence": card["confidence"],
                "recommendation": card["recommendation"],
                "decision": session.decision,
                "finished": session.ctx.is_finished(),
                "durationSeconds": session.duration_seconds(),
                "integrityCount": len(session.integrity),
                "scores": scores,
                "createdAt": session.created_at.isoformat(),
            }
        )
    rows.sort(key=lambda r: (r["overall"] is None, -(r["overall"] or 0)))
    return {
        "rubric": rubric,
        "title": title,
        "skills": [{"key": s.key, "name": s.name, "weight": s.weight} for s in skills],
        "candidates": rows,
    }


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
            "shot": f.shot,
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


class SkillBody(BaseModel):
    name: str = Field(max_length=60)
    what_good_looks_like: str = Field(max_length=600)
    weight: float = 1.0
    cross_cutting: bool = False


class RoleBody(BaseModel):
    """A role a recruiter wrote.

    `what_good_looks_like` is the field that matters: it goes into the system
    prompt verbatim and is what the interviewer probes against. A vague one
    produces a vague interview.
    """

    title: str = Field(max_length=80)
    skills: list[SkillBody] = Field(min_length=2, max_length=8)


def _role(key: str) -> dict:
    title, skills = load_rubric(key)
    return {
        "key": key,
        "title": title,
        "builtin": is_builtin(key),
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


@app.get("/roles")
def roles(_: str = Depends(current_recruiter)) -> list[dict]:
    return [_role(key) for key in list_rubrics()]


@app.post("/roles")
def create_role(body: RoleBody, _: str = Depends(current_recruiter)) -> dict:
    """Add a role. Shipped roles stay read-only; this writes alongside them."""
    key = slugify(body.title)
    if key in list_rubrics():
        raise HTTPException(status.HTTP_409_CONFLICT, f"A role called {body.title} already exists.")
    try:
        save_rubric(key, body.title, [s.model_dump() for s in body.skills])
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _role(key)


@app.put("/roles/{key}")
def update_role(key: str, body: RoleBody, _: str = Depends(current_recruiter)) -> dict:
    try:
        save_rubric(key, body.title, [s.model_dump() for s in body.skills])
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _role(key)


@app.delete("/roles/{key}")
def remove_role(key: str, _: str = Depends(current_recruiter)) -> dict:
    """Past scorecards survive this: a session stores its own copy of the skills
    it was interviewed against, so deleting a role cannot rewrite history."""
    try:
        delete_rubric(key)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"deleted": key}


class DraftRequest(BaseModel):
    jobDescription: str = Field(min_length=40, max_length=8000)


@app.post("/roles/draft")
def draft_role(body: DraftRequest, _: str = Depends(current_recruiter)) -> dict:
    """Turn a pasted job description into a first draft of a rubric.

    A draft, not a role: nothing is saved until a person has read it. Writing
    "what a strong answer contains" from scratch for five skills is the tedious
    part of adding a role, and it is the part a model is good at.
    """
    try:
        return draft_rubric(body.jobDescription)
    except ValueError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


@app.get("/evals")
def evals(_: str = Depends(current_recruiter)) -> dict:
    """The last eval report, plus whether one is running right now."""
    report = {
        "ranAt": None,
        "model": "",
        "provider": "",
        "runs": [],
        "errors": [],
        "summary": {"total": 0, "passed": 0, "branchingProven": False},
    }
    if EVALS_RESULTS.is_file():
        try:
            report = {**report, **json.loads(EVALS_RESULTS.read_text(encoding="utf-8"))}
        except ValueError:
            pass
    return {**report, "run": evalruns.status()}


@app.post("/evals/run", status_code=status.HTTP_202_ACCEPTED)
def run_evals(_: str = Depends(current_recruiter)) -> dict:
    """Re-run the scripted candidates now.

    The point is that a reader does not have to trust the committed file: they
    can press this, watch the numbers move, and see the same result appear.
    """
    try:
        evalruns.start(EVALS_RESULTS)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return evalruns.status()


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
