"""Loading roles, rubrics and resumes into an interview context."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import yaml

from .agent.state import InterviewContext, Skill
from .agent.tools import seed_claims

RUBRIC_DIR = Path(__file__).resolve().parent.parent / "rubrics"

# Rubric names come from a request body. Anything that is not a plain slug is a
# path, and a path is not a rubric.
_RUBRIC_NAME = re.compile(r"^[a-z0-9_]{1,40}$")

# Lines that read like a claim worth probing: a verb about building, with an object.
_CLAIM_HINT = re.compile(
    r"\b(built|build|developed|designed|implemented|deployed|led|created|automated|"
    r"integrated|optimi[sz]ed|migrated|scaled|shipped)\b",
    re.IGNORECASE,
)


def list_rubrics() -> list[str]:
    return sorted(p.stem for p in RUBRIC_DIR.glob("*.yaml") if _RUBRIC_NAME.match(p.stem))


def load_rubric(name: str) -> tuple[str, list[Skill]]:
    if not _RUBRIC_NAME.match(name):
        raise ValueError(f"invalid rubric name: {name!r}")
    path = RUBRIC_DIR / f"{name}.yaml"
    if not path.is_file():
        raise ValueError(f"unknown rubric: {name}")

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    try:
        skills = [
            Skill(
                key=s["key"],
                name=s["name"],
                what_good_looks_like=" ".join(s["what_good_looks_like"].split()),
                weight=float(s.get("weight", 1.0)),
                cross_cutting=bool(s.get("cross_cutting", False)),
            )
            for s in data["skills"]
        ]
        return data["role_title"], skills
    except (KeyError, TypeError) as exc:
        raise ValueError(f"rubric {name} is malformed: {exc}") from exc


def extract_claims(resume_text: str, limit: int = 8) -> list[str]:
    """Pull the resume lines that assert the candidate did something.

    These are what the agent probes. A claim nobody checks is just a sentence.
    """
    claims: list[str] = []
    for raw in resume_text.splitlines():
        line = raw.strip(" \t-•*")
        if len(line) < 25 or len(line) > 300:
            continue
        if _CLAIM_HINT.search(line):
            claims.append(" ".join(line.split()))
        if len(claims) >= limit:
            break
    return claims


def build_context(
    rubric_name: str,
    resume_text: str = "",
    session_id: str | None = None,
) -> InterviewContext:
    role_title, skills = load_rubric(rubric_name)
    ctx = InterviewContext(
        session_id=session_id or str(uuid.uuid4()),
        role_title=role_title,
        skills=skills,
        resume_text=resume_text.strip(),
    )
    seed_claims(ctx, extract_claims(resume_text))
    return ctx
