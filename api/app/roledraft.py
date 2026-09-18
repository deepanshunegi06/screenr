"""A job description in, a draft rubric out.

Adding a role by hand means writing "what a strong answer contains" five times,
in the specific voice the interviewer needs: concrete, checkable, about things a
candidate either did or did not do. That is the tedious part of the job and the
part a model is genuinely good at.

It is drafted by the same model that runs the interviews, through `brain.py`, so
the rubric is written in the voice of whoever will be reading it. What comes back
is a draft: nothing is saved until a person has read it, because a rubric decides
what every candidate for that role gets asked.
"""

from __future__ import annotations

from .brain import think_json
from .roles import MAX_SKILLS, slugify

PROMPT = """You turn a job description into an interview rubric.

Reply with JSON and nothing else -- no prose before it, no code fences:

{"title": "the role title", "skills": [
  {"name": "...", "what_good_looks_like": "...", "weight": 1.0, "cross_cutting": false}
]}

Return 4 or 5 skills. `what_good_looks_like` is two or three sentences naming
what a strong answer contains. Write them exactly like these, which come from a
working rubric:

  "Names the database and framework they personally chose and gives the reason
  that decided it. Describes one thing that broke and how they diagnosed it, not
  just that it was fixed."

  "Describes one endpoint they designed with its request and response shape, why
  the tables are split the way they are, and one error or edge case they handled.
  Bonus: a migration, N+1, or nullable column that bit them."

Notice the shape:
- Third person about the candidate -- "Names...", "Describes...", "Explains...".
  Never "You describe": this text is read by the interviewer, not the candidate.
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
- One skill may have cross_cutting true: judged from how they talk across the
  whole conversation rather than from a question of its own. Communication is the
  usual one, and it takes weight 0.5. Every other skill is weight 1.0 unless the
  description is explicit that one thing matters more."""


async def draft_rubric(job_description: str) -> dict:
    """Raises ValueError with something worth showing when the model is unreachable."""
    draft = await think_json(PROMPT, job_description.strip()[:8000])

    title = str(draft.get("title") or "").strip()
    skills = draft.get("skills")
    if not title or not isinstance(skills, list) or not skills:
        raise ValueError("Nothing usable came back. Add the skills by hand.")

    out = []
    for skill in skills[:MAX_SKILLS]:
        if not isinstance(skill, dict):
            continue
        name = " ".join(str(skill.get("name", "")).split())[:60]
        good = " ".join(str(skill.get("what_good_looks_like", "")).split())
        if not name or not good:
            continue
        cross = bool(skill.get("cross_cutting", False))
        try:
            weight = float(skill.get("weight", 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        out.append(
            {
                "key": slugify(name),
                "name": name,
                "weight": 0.5 if cross else max(0.1, min(3.0, weight)),
                "cross_cutting": cross,
                "what_good_looks_like": good,
            }
        )

    if not out:
        raise ValueError("Nothing usable came back. Add the skills by hand.")
    return {"key": slugify(title), "title": title[:80], "skills": out}
