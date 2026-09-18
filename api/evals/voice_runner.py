"""The same personas, against the stack a real candidate talks to.

`runner.py` drives the LangGraph path with our own provider. That tests the
shared layer -- tools, scoring, the rubric -- but the judgement it measures comes
from a model no candidate will ever meet. A voice interview is a different
driver and a different model.

This closes that gap by pushing each persona through the real Deepgram socket,
answering in text instead of speech. Everything else is production: Deepgram's
turn-taking, `claude-sonnet-5` deciding, and the same `tools.py` executing what
it decides.

It costs Deepgram agent-hours, so it is the slow check you run before a demo
rather than the free one that runs on every push. Slow is relative: the six
personas run concurrently, so a sweep takes as long as the longest interview
rather than the sum of all six.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from app import store
from app.deepgram_driver import BOOTSTRAP, DeepgramInterview
from app.scoring import build_scorecard

from .personas import Persona
from .runner import Run, _checks

log = logging.getLogger(__name__)

# The agent sends several assistant lines per turn -- a greeting, then the
# question -- with no marker for the last one. A gap this long means it has
# stopped talking. Too short and a question gets answered before it is finished.
QUIET_SECONDS = 1.2
# Nothing at all came back. Deepgram's think latency is a few seconds, so this
# only fires when the agent has genuinely finished with us.
SILENCE_TIMEOUT = 20.0


async def _next_question(spoke: asyncio.Event, said: list[str]) -> str | None:
    """Wait for the agent to stop talking. None when it never started.

    Returning None rather than the previous line matters: an agent that has
    said its piece would otherwise be re-answered until the turn cap, at a
    minute of dead waiting each time.
    """
    seen = len(said)
    deadline = time.monotonic() + SILENCE_TIMEOUT
    while time.monotonic() < deadline:
        try:
            await asyncio.wait_for(spoke.wait(), timeout=QUIET_SECONDS)
            spoke.clear()
        except TimeoutError:
            if len(said) > seen:
                return said[-1]
    return said[-1] if len(said) > seen else None


async def run_voice_interview(
    persona: Persona, max_turns: int = 16, rubric: str = "backend_intern"
) -> Run:
    """One persona, one real agent socket. The session is deleted afterwards."""
    persona.reset()
    session = store.create(
        candidate_email=f"eval+{persona.name}@screenr.local",
        candidate_name=f"eval {persona.name}",
        rubric=rubric,
        resume_text=persona.resume,
    )
    store.start(session)

    said: list[str] = []
    spoke = asyncio.Event()

    async def on_text(frame: dict) -> None:
        if frame.get("type") == "ConversationText" and frame.get("role") == "assistant":
            if text := (frame.get("content") or "").strip():
                said.append(text)
                spoke.set()

    agent = DeepgramInterview(session)
    agent.on_text = on_text
    # on_audio stays None: the agent still speaks, we just drop it on the floor.

    pump: asyncio.Task | None = None
    try:
        await agent.connect()
        pump = asyncio.create_task(agent.pump())

        # Nothing is scripted -- the opening question comes from the rubric and
        # this persona's resume, exactly as it does for a candidate.
        await agent.inject_text(BOOTSTRAP)
        question = await _next_question(spoke, said)

        for _ in range(max_turns):
            if question is None or session.ctx.is_finished() or not agent.open:
                break
            await agent.inject_text(persona.answer(question))
            question = await _next_question(spoke, said)

        if not session.ctx.is_finished():
            await agent.request_end("turn_cap")

        transcript = [(t["speaker"], t["text"]) for t in session.transcript]
        run = Run(
            persona=persona,
            transcript=transcript,
            context=session.ctx,
            scorecard=build_scorecard(session.ctx),
        )
        run.checks = _checks(run)
        return run
    finally:
        if pump:
            pump.cancel()
            with contextlib.suppress(BaseException):
                await pump
        with contextlib.suppress(Exception):
            await agent.close()
        # In the finally, not after the return: a cancelled sweep must not leave
        # fake candidates sitting in the recruiter's list.
        store.delete(session.id)


async def run_all(personas: list[Persona], max_turns: int = 16) -> list[Run | BaseException]:
    """Every persona at once.

    They were sequential at first, on the theory that interviews should be
    measured one at a time. That cost twenty minutes a sweep, which is a sweep
    nobody runs twice. The sockets are independent and production holds many
    open at once anyway, so a sweep now takes as long as its slowest interview.
    """
    return await asyncio.gather(
        *(run_voice_interview(p, max_turns=max_turns) for p in personas),
        return_exceptions=True,
    )


def clear_stray_sessions() -> int:
    """Remove eval sessions a killed sweep left behind."""
    strays = [s.id for s in store.all_sessions() if s.candidate_email.startswith("eval+")]
    for session_id in strays:
        store.delete(session_id)
    return len(strays)
