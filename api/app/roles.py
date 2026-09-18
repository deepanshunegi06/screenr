"""Loading roles, rubrics and resumes into an interview context."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import yaml

from .agent.retrieval import chunk_text
from .agent.state import InterviewContext, Skill
from .agent.tools import seed_claims

RUBRIC_DIR = Path(__file__).resolve().parent.parent / "rubrics"

# Lines that read like a claim worth probing: a verb about building, with an object.
_CLAIM_HINT = re.compile(
    r"\b(built|build|developed|designed|implemented|deployed|led|created|automated|"
    r"integrated|optimi[sz]ed|migrated|scaled|shipped)\b",
    re.IGNORECASE,
)


def load_rubric(name: str) -> tuple[str, list[Skill]]:
    path = RUBRIC_DIR / f"{name}.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    skills = [
        Skill(
            key=s["key"],
            name=s["name"],
            what_good_looks_like=" ".join(s["what_good_looks_like"].split()),
            weight=float(s.get("weight", 1.0)),
        )
        for s in data["skills"]
    ]
    return data["role_title"], skills


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
        resume_chunks=chunk_text(resume_text) if resume_text else [],
    )
    seed_claims(ctx, extract_claims(resume_text))
    return ctx
