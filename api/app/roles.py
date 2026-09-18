"""Loading roles, rubrics and resumes into an interview context."""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import yaml

from .agent.state import InterviewContext, Skill
from .agent.tools import seed_claims
from .config import get_settings

RUBRIC_DIR = Path(__file__).resolve().parent.parent / "rubrics"
# Roles a recruiter writes live with the rest of the state, not in the repo. The
# two directories hold the same file format, so a custom role can be read, diffed
# and hand-edited exactly like a shipped one.
CUSTOM_DIR = Path(get_settings().data_dir) / "rubrics"

# Rubric names come from a request body. Anything that is not a plain slug is a
# path, and a path is not a rubric.
_RUBRIC_NAME = re.compile(r"^[a-z0-9_]{1,40}$")

MAX_SKILLS = 8
MIN_SKILLS = 2

# Lines that read like a claim worth probing: a verb about building, with an object.
_CLAIM_HINT = re.compile(
    r"\b(built|build|developed|designed|implemented|deployed|led|created|automated|"
    r"integrated|optimi[sz]ed|migrated|scaled|shipped)\b",
    re.IGNORECASE,
)


def _path(name: str) -> Path | None:
    """Where a rubric lives, shipped or written here. None if there is no such role."""
    if not _RUBRIC_NAME.match(name):
        raise ValueError(f"invalid rubric name: {name!r}")
    for folder in (RUBRIC_DIR, CUSTOM_DIR):
        candidate = folder / f"{name}.yaml"
        if candidate.is_file():
            return candidate
    return None


def is_builtin(name: str) -> bool:
    """Shipped roles are read-only. They are documentation as much as config."""
    return bool(_RUBRIC_NAME.match(name)) and (RUBRIC_DIR / f"{name}.yaml").is_file()


def list_rubrics() -> list[str]:
    names = {p.stem for folder in (RUBRIC_DIR, CUSTOM_DIR) for p in folder.glob("*.yaml")}
    return sorted(n for n in names if _RUBRIC_NAME.match(n))


def load_rubric(name: str) -> tuple[str, list[Skill]]:
    path = _path(name)
    if path is None:
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


def slugify(title: str) -> str:
    """A file-safe key from a role title. Collisions are the caller's problem."""
    slug = re.sub(r"[^a-z0-9]+", "_", title.strip().lower()).strip("_")
    return slug[:40] or "role"


def save_rubric(name: str, title: str, skills: list[dict]) -> None:
    """Write a recruiter-authored role.

    Everything here arrives from a form, so it is validated rather than trusted:
    a rubric is read back into the system prompt of every interview for this
    role, and a malformed one would fail at the worst possible moment.
    """
    if not _RUBRIC_NAME.match(name):
        raise ValueError("The key must be lowercase letters, numbers and underscores.")
    if is_builtin(name):
        raise ValueError(f"{name} is a built-in role and can't be overwritten.")
    title = " ".join(title.split())
    if not 1 <= len(title) <= 80:
        raise ValueError("Give the role a title of 80 characters or less.")
    if not MIN_SKILLS <= len(skills) <= MAX_SKILLS:
        raise ValueError(f"A role needs between {MIN_SKILLS} and {MAX_SKILLS} skills.")

    cleaned = []
    seen: set[str] = set()
    for skill in skills:
        key = slugify(str(skill.get("key") or skill.get("name", "")))
        if not _RUBRIC_NAME.match(key):
            raise ValueError("Every skill needs a name.")
        if key in seen:
            raise ValueError(f"Two skills share the key {key}.")
        seen.add(key)
        good = " ".join(str(skill.get("what_good_looks_like", "")).split())
        if not 20 <= len(good) <= 600:
            raise ValueError(
                f"'{skill.get('name', key)}' needs 20 to 600 characters describing what a "
                "strong answer contains -- that text is what the interviewer probes against."
            )
        weight = float(skill.get("weight", 1.0))
        if not 0.1 <= weight <= 3:
            raise ValueError("Weights run from 0.1 to 3.")
        cleaned.append(
            {
                "key": key,
                "name": " ".join(str(skill.get("name", "")).split())[:60] or key,
                "weight": round(weight, 2),
                "cross_cutting": bool(skill.get("cross_cutting", False)),
                "what_good_looks_like": good,
            }
        )

    if all(s["cross_cutting"] for s in cleaned):
        # Cross-cutting skills are scored from the whole conversation and never
        # drive a question, so an interview made only of them has nothing to ask.
        raise ValueError("At least one skill has to be a regular, askable one.")

    CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    (CUSTOM_DIR / f"{name}.yaml").write_text(
        yaml.safe_dump({"role_title": title, "skills": cleaned}, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def delete_rubric(name: str) -> None:
    if is_builtin(name):
        raise ValueError(f"{name} is a built-in role and can't be deleted.")
    path = _path(name)
    if path is None:
        raise ValueError(f"unknown rubric: {name}")
    path.unlink()


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
