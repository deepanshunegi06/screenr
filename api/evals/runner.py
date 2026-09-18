"""Drive a persona through a whole interview, in text, with no audio.

Each run carries the checks derived from the persona's expectations, so the same
object feeds pytest, the CLI, and the JSON report the evals page renders.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.agent.graph import Interviewer
from app.agent.state import InterviewContext
from app.roles import build_context
from app.scoring import build_scorecard

from .personas import Persona

_WORDS = re.compile(r"[a-z0-9]+")


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


@dataclass
class Run:
    persona: Persona
    transcript: list[tuple[str, str]]
    context: InterviewContext
    scorecard: dict
    checks: list[Check] = field(default_factory=list)

    @property
    def tool_sequence(self) -> list[str]:
        return [name for turn in self.context.tool_log for name in turn]

    @property
    def questions(self) -> list[str]:
        return [text for who, text in self.transcript if who == "agent"]

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    def pretty(self) -> str:
        lines = [f"=== {self.persona.name} ==="]
        for who, text in self.transcript:
            lines.append(f"{who:>9}: {text}")
        lines.append(f"    tools: {' -> '.join(self.tool_sequence) or 'none'}")
        lines.append(
            f"  verdict: {self.scorecard['recommendation']} "
            f"(overall {self.scorecard['overall']}, {self.scorecard['confidence']} confidence)"
        )
        for c in self.checks:
            lines.append(f"  [{'ok' if c.passed else 'FAIL'}] {c.name}: {c.detail}")
        return "\n".join(lines)

    def to_report(self) -> dict:
        return {
            "persona": self.persona.name,
            "description": self.persona.description,
            "recommendation": self.scorecard["recommendation"],
            "overall": self.scorecard["overall"],
            "confidence": self.scorecard["confidence"],
            "toolSequence": self.tool_sequence,
            "questions": self.questions,
            "transcript": [{"speaker": who, "text": text} for who, text in self.transcript],
            "passed": self.passed,
            "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in self.checks],
        }


def _checks(run: Run) -> list[Check]:
    exp = run.persona.expect
    card = run.scorecard
    ctx = run.context
    out: list[Check] = []

    if "min_overall" in exp:
        ok = card["overall"] is not None and card["overall"] >= exp["min_overall"]
        out.append(Check("overall at least", ok, f"{card['overall']} >= {exp['min_overall']}"))
    if "max_overall" in exp:
        ok = card["overall"] is None or card["overall"] <= exp["max_overall"]
        out.append(Check("overall at most", ok, f"{card['overall']} <= {exp['max_overall']}"))
    if "recommendation" in exp:
        ok = card["recommendation"] in exp["recommendation"]
        detail = f"{card['recommendation']} in {sorted(exp['recommendation'])}"
        out.append(Check("recommendation", ok, detail))
    if exp.get("escalates"):
        ok = "escalate_to_human" in run.tool_sequence
        out.append(Check("escalated to a human", ok, "escalate_to_human called" if ok else "never called"))
    if exp.get("no_perfect_scores"):
        fives = [e for e in ctx.evidence if e.score == 5]
        out.append(Check("no score of 5 granted", not fives, f"{len(fives)} pieces scored 5"))
    if exp.get("probes"):
        n = run.tool_sequence.count("plan_probe")
        out.append(Check("probed for specifics", n > 0, f"plan_probe called {n} times"))
    if exp.get("fully_covered"):
        left = [s.key for s in ctx.uncovered_skills()]
        out.append(Check("every skill covered", not left, f"uncovered: {left or 'none'}"))
        ended = "end_interview" in run.tool_sequence
        detail = "end_interview called" if ended else "ran out of turns"
        out.append(Check("closed the interview", ended, detail))
    if exp.get("refutes_claim"):
        refuted = [c.id for c in ctx.claims if c.status == "refuted"]
        out.append(Check("refuted a resume claim", bool(refuted), f"refuted: {refuted or 'none'}"))

    # Universal checks: the guarantees every interview must keep.
    said = " ".join(a.lower() for a in ctx.answers)
    bad_quotes = []
    for e in ctx.evidence:
        words = _WORDS.findall(e.quote.lower())
        if words and sum(w in said for w in words) < 0.7 * len(words):
            bad_quotes.append(e.quote[:60])
    out.append(Check("every quote is verbatim", not bad_quotes, f"{len(bad_quotes)} paraphrased"))

    qs = [q.lower().strip() for q in run.questions]
    out.append(
        Check(
            "no question repeated", len(set(qs)) == len(qs), f"{len(qs)} questions, {len(set(qs))} distinct"
        )
    )

    turns = ctx.tool_log[1:]  # skip the opening
    if turns:
        active = sum(bool({"record_evidence", "plan_probe"} & set(t)) for t in turns)
        ok = active >= 0.8 * len(turns)
        out.append(Check("evidence or probe on most turns", ok, f"{active}/{len(turns)} turns"))
    return out


def run_interview(persona: Persona, max_turns: int = 10, rubric: str = "backend_intern") -> Run:
    ctx = build_context(rubric, resume_text=persona.resume, session_id=f"eval-{persona.name}")
    agent = Interviewer(ctx)

    transcript: list[tuple[str, str]] = []
    question = agent.open()
    transcript.append(("agent", question))

    for _ in range(max_turns):
        if ctx.is_finished():
            break
        reply = persona.answer(question)
        transcript.append(("candidate", reply))
        question = agent.turn(reply)
        transcript.append(("agent", question))

    run = Run(persona=persona, transcript=transcript, context=ctx, scorecard=build_scorecard(ctx))
    run.checks = _checks(run)
    return run


def build_report(runs: list[Run], model: str, provider: str, ran_at: str) -> dict:
    sequences = {tuple(r.tool_sequence) for r in runs}
    return {
        "ranAt": ran_at,
        "model": model,
        "provider": provider,
        "runs": [r.to_report() for r in runs],
        "summary": {
            "total": len(runs),
            "passed": sum(r.passed for r in runs),
            # Two candidates, two tool sequences: the agent chose differently.
            "branchingProven": len(sequences) > 1,
        },
    }
