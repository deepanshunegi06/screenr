"""Deepgram Voice Agent as the driver.

Deepgram owns the socket, turn-taking and the model call. We own everything that
has to be true about an interview: the tools it can call, the rubric behind them,
the evidence recorded, the probe budget, and state that outlives the connection.

Three settings here are doing more work than they look like they are:

* ``eot_timeout_ms`` is raised well above the default. In an interview a long
  pause means someone is thinking, not finished. Cutting them off at a
  conversational default produces a worse interview than any model choice.
* ``keyterms`` carries the vocabulary of the rubric and the candidate's own
  resume, so "pgvector" and "LangGraph" survive transcription.
* ``mip_opt_out`` is on. Candidate interviews are not training data.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import websockets

from .agent.graph import render_system_prompt
from .agent.schemas import deepgram_functions, run_tool
from .config import get_settings
from .store import Session

AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"

# Declared in Settings and used by stream_silence. One constant, because a
# mismatch here is silent: Deepgram accepts the frames and hears noise.
AUDIO_INPUT_RATE = 16000

# Tools whose effect cannot be walked back. Deepgram holds these until the
# candidate has actually finished speaking, so the agent cannot end the interview
# over the top of someone mid-sentence.
IRREVERSIBLE = {"end_interview", "escalate_to_human"}

# Telemetry: forwarded to the browser so it can show state honestly, but it
# changes nothing on our side.
TELEMETRY = {"History", "LatencyReport", "AgentAudioDone", "AgentThinking", "Warning"}

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9+.#_-]{2,}")
_COMMON = {
    "the", "and", "for", "with", "that", "this", "から", "used", "using", "built",
    "from", "into", "were", "was", "had", "has", "have", "what", "when", "which",
    "their", "there", "would", "could", "should", "about", "after", "before",
}


def keyterms_for(session: Session) -> list[str]:
    """Technical vocabulary this interview is likely to contain.

    Pulled from the rubric and the candidate's own resume rather than a fixed
    list, because the words that matter are the ones specific to what they built.
    """
    source = " ".join(
        [
            *(s.name for s in session.ctx.skills),
            *(s.what_good_looks_like for s in session.ctx.skills),
            *(c.text for c in session.ctx.claims),
            *session.ctx.resume_chunks,
        ]
    )
    seen: dict[str, None] = {}
    for word in _WORD.findall(source):
        if word.lower() in _COMMON or word.islower() and len(word) < 5:
            continue
        seen.setdefault(word, None)
    return list(seen)[:50]


def build_settings(session: Session, resume: bool = False) -> dict[str, Any]:
    """The opening frame.

    ``greeting`` stays empty on purpose: the first question is generated from the
    rubric and the candidate's resume, not read from a constant.
    """
    settings = get_settings()

    functions = []
    for fn in deepgram_functions(session.ctx):
        if fn["name"] in IRREVERSIBLE:
            fn = {**fn, "defer_until_eot": True}
        functions.append(fn)

    agent: dict[str, Any] = {
        "listen": {
            "provider": {
                "type": "deepgram",
                "version": "v2",
                "model": "flux-general-en",
                "keyterms": keyterms_for(session),
                # A thinking pause is not the end of a turn. These are deliberately
                # patient compared with a support-line default.
                "eot_threshold": 0.8,
                "eot_timeout_ms": 8000,
            }
        },
        "speak": {"provider": {"type": "deepgram", "version": "v2", "model": "flux-kit-en"}},
        "think": {
            "provider": {
                "type": settings.voice_think_provider,
                "model": settings.voice_think_model,
                # No temperature: Anthropic models reject it here and the socket
                # fails with a generic "Failed to think", which points nowhere.
            },
            "prompt": render_system_prompt(session.ctx),
            "functions": functions,
            # No context_length here: Deepgram rejects it for managed LLMs, it is
            # only configurable when you bring your own think endpoint.
        },
        "greeting": "",
    }

    if resume and session.transcript:
        agent["context"] = {"messages": history_messages(session)}

    return {
        "type": "Settings",
        "tags": [session.id],
        # Candidate interviews are not training data.
        "mip_opt_out": True,
        "flags": {"history": True},
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": AUDIO_INPUT_RATE},
            "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
        },
        "agent": agent,
    }


def history_messages(session: Session) -> list[dict[str, Any]]:
    """Rebuild Deepgram's view of the conversation after a dropped connection.

    Only what was said is replayed. Tool calls are not: their effects are already
    in our state and in the refreshed prompt, and replaying them would record the
    same evidence twice.
    """
    return [
        {
            "type": "History",
            "role": "assistant" if turn["speaker"] == "agent" else "user",
            "content": turn["text"],
        }
        for turn in session.transcript
        if turn["speaker"] in ("agent", "candidate")
    ]


class DeepgramInterview:
    """One interview, one socket.

    Audio passes through untouched in both directions. Text frames are where the
    work happens: transcripts recorded, function calls executed against this
    session's context, and the interview ending when a tool says it has.
    """

    def __init__(self, session: Session) -> None:
        self.session = session
        self.ws: websockets.ClientConnection | None = None
        self.on_audio = None  # async callable taking bytes
        self.on_text = None  # async callable taking a dict
        # Deepgram queues an injected message until the agent has finished
        # speaking, and only reports finishing while audio is flowing in. Both
        # facts are load-bearing; see inject_text and stream_silence.
        self._idle = asyncio.Event()
        self._idle.set()
        self._last_frame = 0.0
        self._silence_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None
        self._quiet_task: asyncio.Task | None = None

    async def connect(self, resume: bool = False) -> None:
        settings = get_settings()
        if not settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not set")

        self.ws = await websockets.connect(
            AGENT_URL,
            additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
            max_size=None,
        )
        await self.ws.send(json.dumps(build_settings(self.session, resume=resume)))

    async def send_audio(self, chunk: bytes) -> None:
        if self.ws:
            await self.ws.send(chunk)

    def start_watchdog(self) -> None:
        """Enforce the duration and turn caps on the voice path.

        These caps live in the typed driver's turn loop, which Deepgram never
        calls -- so without this a voice interview has no time limit at all. A
        guardrail that silently does not apply is worse than none, because
        everyone assumes it is working.
        """

        async def watch() -> None:
            settings = get_settings()
            while self.ws and not self.session.ctx.is_finished():
                await asyncio.sleep(5)
                ctx = self.session.ctx
                if ctx.elapsed_seconds() >= settings.max_interview_seconds:
                    ctx.stop_reason = "duration_cap"
                elif ctx.turn_count >= settings.max_turns:
                    ctx.stop_reason = "turn_cap"
                else:
                    continue

                # Close out loud rather than dropping the line on someone.
                if self.ws:
                    await self.ws.send(
                        json.dumps(
                            {
                                "type": "InjectAgentMessage",
                                "content": (
                                    "That is all the time we have. Thanks for walking me "
                                    "through your work -- someone from the team will follow "
                                    "up with next steps."
                                ),
                            }
                        )
                    )
                return

        self._watchdog_task = asyncio.create_task(watch())

    async def inject_text(self, text: str, timeout: float = 30.0) -> None:
        """Drive a turn without audio.

        Same socket, same model, same tools, no microphone. This is the fallback
        when a candidate's audio fails and they switch to typing.

        Waits for the agent to stop speaking first. Deepgram accepts an injection
        sent mid-utterance without complaint and then never acts on it, so sending
        eagerly loses the turn silently -- the worst kind of bug to find later.
        """
        if not self.ws:
            return
        try:
            await asyncio.wait_for(self._idle.wait(), timeout=timeout)
        except TimeoutError:
            # Better a turn out of order than a candidate waiting on silence.
            pass
        if not self.ws:
            return  # closed while we were waiting for the agent to finish
        await self.ws.send(json.dumps({"type": "InjectUserMessage", "content": text}))

    def start_quiet_watch(self, quiet_seconds: float = 6.0) -> None:
        """Treat a gap in traffic as the agent having finished.

        AgentAudioDone is the documented signal and it is not reliably delivered
        -- observed never arriving across a 50 second wait on a socket that was
        otherwise healthy. Waiting on it alone deadlocks the next turn, so a gap
        with no frames at all counts as finished too.
        """

        async def watch() -> None:
            while self.ws:
                await asyncio.sleep(0.5)
                if self._last_frame and time.monotonic() - self._last_frame > quiet_seconds:
                    self._idle.set()

        self._quiet_task = asyncio.create_task(watch())

    def stream_silence(self, sample_rate: int = AUDIO_INPUT_RATE) -> None:
        """Feed the socket silence when no real microphone is attached.

        Deepgram only emits AgentAudioDone while input audio is flowing. Without
        it the connection stalls after the first exchange: injections queue up
        behind an agent that is never reported as having finished speaking.
        """
        frame = b"\x00" * (sample_rate // 50 * 2)  # 20ms, mono, linear16

        async def pump_silence() -> None:
            while self.ws:
                try:
                    await self.ws.send(frame)
                    await asyncio.sleep(0.02)
                except (websockets.ConnectionClosed, TypeError):
                    return

        self._silence_task = asyncio.create_task(pump_silence())

    async def pump(self) -> None:
        """Read from Deepgram until the interview ends or the socket closes."""
        assert self.ws is not None
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    if self.on_audio:
                        await self.on_audio(message)
                    continue
                await self._handle(json.loads(message))
                if self.session.ctx.is_finished():
                    await asyncio.sleep(3)  # let the closing line finish speaking
                    break
        except websockets.ConnectionClosed:
            pass
        finally:
            await self.close()

    async def _handle(self, frame: dict[str, Any]) -> None:
        kind = frame.get("type")

        self._last_frame = time.monotonic()
        if kind in ("AgentStartedSpeaking", "AgentThinking", "UserStartedSpeaking"):
            self._idle.clear()
        elif kind == "AgentAudioDone":
            self._idle.set()

        if kind == "ConversationText":
            role = frame.get("role")
            text = (frame.get("content") or "").strip()
            if text and role == "assistant":
                self.session.record("agent", text)
                self.session.ctx.asked.append(text)
            elif text:
                self.session.record("candidate", text)
                self.session.ctx.turn_count += 1

        elif kind == "FunctionCallRequest":
            await self._run_functions(frame.get("functions", []))

        elif kind == "Error":
            self.session.record("system", f"deepgram error: {frame.get('description', '')}")

        elif kind not in TELEMETRY:
            pass

        if self.on_text:
            await self.on_text(frame)

    async def _run_functions(self, calls: list[dict[str, Any]]) -> None:
        assert self.ws is not None
        names: list[str] = []

        for call in calls:
            name = call.get("name", "")
            raw = call.get("arguments") or "{}"
            try:
                arguments = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                arguments = {}

            # Tools mutate shared state, so keep them off the event loop thread.
            result = await asyncio.to_thread(run_tool, self.session.ctx, name, arguments)
            names.append(name)

            await self.ws.send(
                json.dumps(
                    {
                        "type": "FunctionCallResponse",
                        "id": call.get("id"),
                        "name": name,
                        "content": result,
                    }
                )
            )

        self.session.ctx.tool_log.append(names)

        # The prompt carries live state -- what is still uncovered, what has already
        # been asked. Tools just changed it, so refresh, or the model keeps working
        # from the picture it had when the socket opened.
        await self.ws.send(
            json.dumps({"type": "UpdatePrompt", "prompt": render_system_prompt(self.session.ctx)})
        )

    async def close(self) -> None:
        for task in (self._silence_task, self._watchdog_task, self._quiet_task):
            if task:
                task.cancel()
        self._silence_task = self._watchdog_task = self._quiet_task = None
        self._idle.set()
        if self.ws:
            try:
                await self.ws.close()
            finally:
                self.ws = None
