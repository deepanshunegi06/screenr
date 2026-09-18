"""Tools the interviewer can call.

Every tool is bound to one interview's context by a closure, so a tool call can
never reach another candidate's data. Tools return short strings: the model reads
them as observations and decides what to do next.
"""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from ..config import get_settings
from . import retrieval
from .state import Claim, Evidence, Flag, InterviewContext


def build_tools(ctx: InterviewContext) -> list[BaseTool]:
    settings = get_settings()

    @tool
    def retrieve_rubric(skill_key: str) -> str:
        """Look up what a strong answer for a skill actually contains.

        Call this before probing a weak or vague answer, so the follow-up asks for
        the specific detail the rubric expects rather than a generic 'tell me more'.
        """
        skill = ctx.skill(skill_key)
        if skill is None:
            keys = ", ".join(s.key for s in ctx.skills)
            return f"No skill '{skill_key}'. Available: {keys}"
        return f"{skill.name}: {skill.what_good_looks_like}"

    @tool
    def get_resume_section(query: str) -> str:
        """Search the candidate's resume for what they claimed about a topic.

        Use this when an answer seems to contradict their resume, or when you need
        the specific project name or technology to ask a pointed question about.
        """
        hits = retrieval.search(ctx.resume_chunks, query, k=2)
        if not hits:
            return "Nothing in the resume matches that."
        return "\n---\n".join(hits)

    @tool
    def plan_probe(topic: str) -> str:
        """Reserve a follow-up on a topic before asking it.

        Returns how many probes remain. When the budget is spent, stop digging and
        move to another skill -- an unresolved topic is recorded as insufficient
        evidence, which is a more useful finding than a guess.
        """
        used = ctx.probes.get(topic, 0)
        cap = settings.max_probes_per_topic
        if used >= cap:
            return (
                f"Probe budget for '{topic}' is spent ({used}/{cap}). "
                "Move on and leave this skill with the evidence you have."
            )
        ctx.probes[topic] = used + 1
        return f"Probe {used + 1}/{cap} on '{topic}'. Ask for a specific, checkable detail."

    @tool
    def record_evidence(skill_key: str, score: float, quote: str, note: str) -> str:
        """Record a rubric score backed by what the candidate actually said.

        score is 1-5. quote must be the candidate's own words, so a recruiter can
        check the judgement against the transcript. Never score a skill the
        candidate has not been asked about.
        """
        if ctx.skill(skill_key) is None:
            keys = ", ".join(s.key for s in ctx.skills)
            return f"No skill '{skill_key}'. Available: {keys}"
        if not 1 <= score <= 5:
            return "score must be between 1 and 5."
        if not quote.strip():
            return "quote is required: a score without a source is not usable."

        quote = quote.strip()
        # One answer is one piece of evidence. Without this, a model that re-reads
        # the same good answer each turn inflates the skill it is filed under --
        # observed doing exactly that, five times on one quote.
        if any(e.skill_key == skill_key and e.quote == quote for e in ctx.evidence):
            remaining = [s.key for s in ctx.uncovered_skills()]
            return (
                f"Already recorded that answer against {skill_key}. "
                f"Ask about something else. Still uncovered: {remaining or 'none'}"
            )

        ctx.evidence.append(
            Evidence(
                skill_key=skill_key,
                score=float(score),
                quote=quote,
                note=note.strip(),
                at_seconds=ctx.elapsed_seconds(),
            )
        )
        remaining = [s.key for s in ctx.uncovered_skills()]
        if not remaining:
            return f"Recorded {skill_key}={score}. Every skill now has evidence -- close it out."
        return (
            f"Recorded {skill_key}={score}. Ask about one of these next, "
            f"they have nothing yet: {remaining}"
        )

    @tool
    def mark_claim(claim_id: str, status: str, note: str) -> str:
        """Mark a resume claim as verified or refuted once the candidate has
        explained it in enough detail to tell.

        status is 'verified' or 'refuted'.
        """
        if status not in ("verified", "refuted"):
            return "status must be 'verified' or 'refuted'."
        claim = next((c for c in ctx.claims if c.id == claim_id), None)
        if claim is None:
            ids = ", ".join(c.id for c in ctx.claims) or "none"
            return f"No claim '{claim_id}'. Available: {ids}"
        claim.status = status  # type: ignore[assignment]
        claim.note = note
        left = [c.id for c in ctx.unverified_claims()]
        return f"Claim {claim_id} {status}. Still unverified: {left or 'none'}"

    @tool
    def end_interview(reason: str) -> str:
        """End the interview when every rubric skill has evidence, or when further
        questions would not change the picture. Say a closing line afterwards.

        reason is one of: sufficient_evidence, question_bank_exhausted, candidate_ended.
        """
        allowed = {"sufficient_evidence", "question_bank_exhausted", "candidate_ended"}
        ctx.stop_reason = reason if reason in allowed else "sufficient_evidence"  # type: ignore[assignment]
        return "Interview closed. Give a short, warm closing line and stop asking questions."

    @tool
    def escalate_to_human(reason: str) -> str:
        """Hand the decision to a human when you cannot form a fair judgement --
        contradictory answers, a topic outside the rubric, distress, or anything
        that should not be settled by an automated screen.
        """
        ctx.stop_reason = "escalated"
        ctx.escalation_note = reason
        ctx.flags.append(Flag(kind="escalation", detail=reason))
        return "Escalated. Close politely without telling the candidate they failed."

    return [
        retrieve_rubric,
        get_resume_section,
        plan_probe,
        record_evidence,
        mark_claim,
        end_interview,
        escalate_to_human,
    ]


def seed_claims(ctx: InterviewContext, claims: list[str]) -> None:
    ctx.claims = [Claim(id=f"c{i + 1}", text=t) for i, t in enumerate(claims)]
