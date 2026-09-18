"""Drive a persona through a whole interview, in text, with no audio."""

from __future__ import annotations

from dataclasses import dataclass

from app.agent.graph import Interviewer
from app.agent.state import InterviewContext
from app.roles import build_context
from app.scoring import build_scorecard

from .personas import Persona


@dataclass
class Run:
    persona: str
    transcript: list[tuple[str, str]]
    context: InterviewContext
    scorecard: dict

    @property
    def tool_sequence(self) -> list[str]:
        return [name for turn in self.context.tool_log for name in turn]

    @property
    def questions(self) -> list[str]:
        return [text for who, text in self.transcript if who == "agent"]

    def pretty(self) -> str:
        lines = [f"=== {self.persona} ==="]
        for who, text in self.transcript:
            lines.append(f"{who:>9}: {text}")
        lines.append(f"    tools: {' -> '.join(self.tool_sequence) or 'none'}")
        lines.append(
            f"  verdict: {self.scorecard['recommendation']} "
            f"(overall {self.scorecard['overall']}, {self.scorecard['confidence']} confidence)"
        )
        return "\n".join(lines)


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

    return Run(
        persona=persona.name,
        transcript=transcript,
        context=ctx,
        scorecard=build_scorecard(ctx),
    )
