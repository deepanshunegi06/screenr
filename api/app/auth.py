"""Two kinds of caller, two very different levels of trust.

A **recruiter** signs in with the single configured account and gets a token that
can read every scorecard.

A **candidate** never signs in at all. The recruiter generates an invite, the
candidate opens the link, and the token embedded in that link is their whole
identity. It is scoped to one session, expires, and can read nothing else --
so the worst case for a leaked link is one interview, not the pipeline.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from .config import get_settings

ALGORITHM = "HS256"
Audience = Literal["recruiter", "candidate"]

bearer = HTTPBearer(auto_error=False)


def _secret() -> str:
    secret = get_settings().jwt_secret
    if not secret or secret == "dev-secret-change-me":
        # Loud in production, quiet in local development.
        if get_settings().recruiter_password not in ("", "changeme"):
            raise RuntimeError("JWT_SECRET must be set when a real password is configured")
    return secret or "dev-secret-change-me"


def issue_token(subject: str, audience: Audience, ttl: timedelta) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": subject,
        "aud": audience,
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_urlsafe(8),
    }
    return jwt.encode(payload, _secret(), algorithm=ALGORITHM)


def issue_recruiter_token() -> str:
    return issue_token(get_settings().recruiter_email, "recruiter", timedelta(hours=12))


def issue_candidate_token(session_id: str) -> str:
    # Long enough to cover a reschedule, short enough that a forwarded link dies.
    return issue_token(session_id, "candidate", timedelta(days=3))


def _decode(token: str, audience: Audience) -> dict:
    try:
        return jwt.decode(token, _secret(), algorithms=[ALGORITHM], audience=audience)
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired link") from exc


def verify_login(email: str, password: str) -> bool:
    s = get_settings()
    # Compare both halves regardless of outcome so timing says nothing.
    email_ok = secrets.compare_digest(email.strip().lower(), s.recruiter_email.strip().lower())
    password_ok = secrets.compare_digest(password, s.recruiter_password)
    return email_ok and password_ok


def current_recruiter(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> str:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in first")
    return _decode(credentials.credentials, "recruiter")["sub"]


def candidate_session_id(token: str) -> str:
    """Resolve an invite token to the one session it may touch."""
    return _decode(token, "candidate")["sub"]
