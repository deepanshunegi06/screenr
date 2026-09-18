"""A job description in, a draft rubric out.

Adding a role by hand means writing "what a strong answer contains" five times,
in the specific voice the interviewer needs: concrete, checkable, about things a
candidate either did or did not do. That is the tedious part of the job and the
part a model is genuinely good at.

What comes back is a draft. Nothing is saved until a person has read it, because
a rubric decides what every candidate for that role gets asked.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .llm import build_llm
from .roles import MAX_SKILLS, slugify

PROMPT = """You are helping a recruiter turn a job description into an interview rubric.

Return 4 or 5 skills. For each, write `what_good_looks_like`: two or three
sentences naming what a strong answer contains.

Write it exactly like these, which are from a working rubric:

  "Names the database and framework they personally chose and gives the reason
  that decided it. Describes one thing that broke and how they diagnosed it, not
  just that it was fixed."

  "Describes one endpoint they designed with its request and response shape, why
  the tables are split the way they are, and one error or edge case they handled.
  Bonus: a migration, N+1, or nullable column that bit them."

Notice the shape:
- Third person about the candidate -- "Names...", "Describes...", "Explains...".
  Never "You describe" -- this text is read by the interviewer, not the candidate.
- Checkable things: a decision and the reason for it, a failure and how they
  found it, a shape they can draw. Never adjectives like "solid understanding".

Hard rules:
- Invent no numbers, targets or outcomes. Writing "reduced runtime by 40%" or
  "a 15% lift" turns one person's anecdote into a requirement, and marks down
  every good candidate who did not happen to have that number. Ask what they
  measured, not what the measurement was.
- Name no tool the job description does not name.
- Describe what the candidate did, never what the company offers.
- The title is the job title as a candidate would say it. Not "rubric", not
  "interview", not "assessment" -- just the role.
- One skill may be cross_cutting: judged from how they talk across the whole
  conversation rather than from a question of its own. Communication is the usual
  one. Give it weight 0.5. Every other skill is 1.0 unless the description is
  explicit that one thing matters more.

Job description:
---
{jd}
---"""


class DraftSkill(BaseModel):
    name: str = Field(description="Short skill name, under 60 characters")
    what_good_looks_like: str = Field(description="Two or three concrete, checkable sentences")
    weight: float = Field(default=1.0, description="1.0 normally, 0.5 for a cross-cutting skill")
    cross_cutting: bool = Field(default=False)


class DraftRubric(BaseModel):
    title: str = Field(description="The role title, as a person would say it")
    skills: list[DraftSkill]


def draft_rubric(job_description: str) -> dict:
    """Raises ValueError with something worth showing when the provider is down."""
    try:
        model = build_llm(temperature=0.2).with_structured_output(DraftRubric)
        draft = model.invoke(PROMPT.format(jd=job_description.strip()[:8000]))
    except Exception as exc:
        raise ValueError(f"Couldn't draft from that: {type(exc).__name__}. Add the skills by hand.") from exc

    if not draft or not draft.skills:
        raise ValueError("Nothing usable came back. Add the skills by hand.")

    return {
        "key": slugify(draft.title),
        "title": draft.title[:80],
        "skills": [
            {
                "key": slugify(s.name),
                "name": s.name[:60],
                "weight": 0.5 if s.cross_cutting else max(0.1, min(3.0, s.weight)),
                "cross_cutting": s.cross_cutting,
                "what_good_looks_like": " ".join(s.what_good_looks_like.split()),
            }
            for s in draft.skills[:MAX_SKILLS]
        ],
    }
