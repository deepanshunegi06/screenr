"""Deepgram Voice Agent as the driver.

Deepgram owns the socket, turn-taking and the model call. We own everything that
has to be true about an interview: the tools it can call, the rubric behind them,
the evidence recorded, the probe budget, and state that outlives the connection.

Behaviours of the Voice Agent API that shaped this file, all found by running it:

* An injected user message is queued until the agent has finished speaking, and
  the agent is only reported as finished (``AgentAudioDone``) while input audio is
  flowing. Sending mid-utterance is accepted and then silently never acted on.
* The socket dies on a keepalive ping timeout if nothing is sent while a candidate
  thinks. Deepgram's ``KeepAlive`` frame is the supported fix; the client library's
  own ping policing has to be off.
* ``temperature`` on an Anthropic think provider fails with a generic
  "Failed to think". ``context_length`` is only accepted with a custom endpoint.
* ``eot_timeout_ms`` is raised well above the default. In an interview a long pause
  means someone is thinking, not finished.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

import websockets

from .agent.graph import render_system_prompt
from .agent.schemas import deepgram_functions, run_tool
from .config import get_settings
from .store import Session, finish, save

log = logging.getLogger(__name__)

AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"

# Declared in Settings and expected from the browser. One constant, because a
# mismatch is silent: Deepgram accepts the frames and hears noise.
AUDIO_INPUT_RATE = 16000
AUDIO_OUTPUT_RATE = 24000

# Lines we send to make the agent speak. Scaffolding, not something the candidate
# said, so they never reach the transcript or the page.
BOOTSTRAP = "[The candidate has joined. Begin the interview.]"
RECONNECT = "[The candidate has reconnected. Briefly pick up where you left off.]"
SCAFFOLDING = {BOOTSTRAP, RECONNECT}

# How long to let a closing line play before closing the socket anyway.
CLOSING_LINE_TIMEOUT = 6.0

# Tools whose effect cannot be walked back. Deepgram holds these until the
# candidate has actually finished speaking.
IRREVERSIBLE = {"end_interview"}

_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9+.#_-]{2,}")


def keyterms_for(session: Session) -> list[str]:
    """Technical vocabulary this interview is likely to contain, for the STT.

    Resume and claims first, rubric prose last: the words that matter are the ones
    specific to what this candidate built. Only tokens with a capital or a digit
    survive, which keeps 'pgvector', 'LangGraph' and 'S3' and drops rubric verbs.
    """
    source = " ".join(
        [
            session.ctx.resume_text,
            *(c.text for c in session.ctx.claims),
            *(s.name for s in session.ctx.skills),
            *(s.what_good_looks_like for s in session.ctx.skills),
        ]
    )
    seen: dict[str, None] = {}
    for word in _TOKEN.findall(source):
        if re.search(r"[A-Z0-9]", word):
            seen.setdefault(word, None)
    return list(seen)[:50]


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


def build_settings(session: Session, resume: bool = False) -> dict[str, Any]:
    """The opening frame. ``greeting`` stays empty: the first question is generated
    from the rubric and the candidate's resume, not read from a constant."""
    settings = get_settings()

    functions = [
        {**fn, "defer_until_eot": True} if fn["name"] in IRREVERSIBLE else fn
        for fn in deepgram_functions(session.ctx)
    ]

    agent: dict[str, Any] = {
        "listen": {
            "provider": {
                "type": "deepgram",
                "version": "v2",
                "model": "flux-general-en",
                "keyterms": keyterms_for(session),
                "eot_threshold": 0.8,
                "eot_timeout_ms": 8000,
            }
        },
        "speak": {"provider": {"type": "deepgram", "version": "v2", "model": "flux-kit-en"}},
        "think": {
            "provider": {
                "type": settings.voice_think_provider,
                "model": settings.voice_think_model,
            },
            "prompt": render_system_prompt(session.ctx),
            "functions": functions,
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
            "output": {"encoding": "linear16", "sample_rate": AUDIO_OUTPUT_RATE, "container": "none"},
        },
        "agent": agent,
    }


AudioSink = Callable[[bytes], Awaitable[None]]
TextSink = Callable[[dict[str, Any]], Awaitable[None]]


class DeepgramInterview:
    """One interview, one socket.

    Audio passes through untouched in both directions. Text frames are where the
    work happens: transcripts recorded, function calls executed against this
    session's context, and the interview ending when a tool says it has.
    """

    def __init__(self, session: Session) -> None:
        self.session = session
        self.ws: websockets.ClientConnection | None = None
        self.on_audio: AudioSink | None = None
        self.on_text: TextSink | None = None

        # Set while the agent is idle. inject_text waits on it.
        self._idle = asyncio.Event()
        self._idle.set()
        self._last_frame = 0.0
        # One turn in flight at a time, or several typed answers waiting on _idle
        # are all released together and arrive as one turn.
        self._turn_lock = asyncio.Lock()
        # Tool names from the current think step, attached to the assistant line
        # they produced so the transcript shows what the agent did and why.
        self._pending_tools: list[str] = []
        self._tasks: list[asyncio.Task] = []

    # --- lifecycle ---------------------------------------------------------------

    async def connect(self, resume: bool = False) -> None:
        settings = get_settings()
        if not settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not set")

        self.ws = await websockets.connect(
            AGENT_URL,
            additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
            max_size=None,
            # Deepgram does not answer protocol pings promptly; the library's own
            # policing closes a healthy socket with 1011. KeepAlive frames instead.
            ping_interval=None,
        )
        await self.ws.send(json.dumps(build_settings(self.session, resume=resume)))
        self._tasks = [
            asyncio.create_task(self._keepalive()),
            asyncio.create_task(self._quiet_watch()),
            asyncio.create_task(self._watchdog()),
        ]

    async def close(self) -> None:
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._idle.set()
        if self.ws:
            ws, self.ws = self.ws, None
            with contextlib.suppress(Exception):
                await ws.close()

    @property
    def open(self) -> bool:
        return self.ws is not None

    async def _send(self, frame: dict[str, Any]) -> bool:
        if not self.ws:
            return False
        try:
            await self.ws.send(json.dumps(frame))
            return True
        except websockets.ConnectionClosed:
            await self.close()
            return False

    # --- input -------------------------------------------------------------------

    async def send_audio(self, chunk: bytes) -> None:
        if not self.ws:
            return
        try:
            await self.ws.send(chunk)
        except websockets.ConnectionClosed:
            await self.close()

    async def inject_text(self, text: str, timeout: float = 30.0) -> None:
        """Drive a turn without audio -- the typed fallback and the opening line.

        Waits for the agent to stop speaking first. Deepgram accepts an injection
        sent mid-utterance without complaint and then never acts on it, so sending
        eagerly loses the turn silently.
        """
        async with self._turn_lock:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._idle.wait(), timeout=timeout)
            if await self._send({"type": "InjectUserMessage", "content": text}):
                self._idle.clear()
                self._last_frame = time.monotonic()

    async def request_end(self, reason: str = "candidate_ended") -> None:
        """End now. Not after a closing line, not after a timeout -- now.

        Whoever asked has already decided: the candidate pressed the button, or
        the warning limit was reached. Making them watch a spinner while a
        courtesy sentence plays is the one thing this must not do. The socket is
        closed immediately and the caller tells the browser.
        """
        finish(self.session, reason)
        await self.close()

    # --- output ------------------------------------------------------------------

    async def pump(self) -> None:
        """Read from Deepgram until the interview ends or the socket closes."""
        assert self.ws is not None
        try:
            async for message in self.ws:
                self._last_frame = time.monotonic()
                if isinstance(message, bytes):
                    if self.on_audio:
                        await self.on_audio(message)
                    continue
                await self._handle(json.loads(message))
                if self.session.ctx.is_finished():
                    # Let the closing line finish, but never hold the candidate on
                    # a finished screen: they have already asked to stop.
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(self._idle.wait(), timeout=CLOSING_LINE_TIMEOUT)
                    break
        except websockets.ConnectionClosed:
            pass
        finally:
            await self.close()

    async def _handle(self, frame: dict[str, Any]) -> None:
        kind = frame.get("type")

        if kind in ("AgentStartedSpeaking", "AgentThinking", "UserStartedSpeaking"):
            self._idle.clear()
        elif kind == "AgentAudioDone":
            self._idle.set()

        if kind == "ConversationText":
            role = frame.get("role")
            text = (frame.get("content") or "").strip()
            if not text:
                return
            if role == "assistant":
                self.session.record("agent", text, tools=self._pending_tools)
                self._pending_tools = []
                self.session.ctx.asked.append(text)
            elif text in SCAFFOLDING:
                return  # our own scaffolding, never the candidate's words
            else:
                ctx = self.session.ctx
                ctx.turn_count += 1
                ctx.answers.append(text)
                self.session.record("candidate", text)
                # The prompt carries live state; refresh it so the model sees the
                # new turn count and any nudge before it thinks.
                await self._refresh_prompt()

        elif kind == "FunctionCallRequest":
            await self._run_functions(frame.get("functions", []))

        elif kind == "Error":
            log.warning("deepgram error on %s: %s", self.session.id, frame.get("description"))
            self.session.record("system", f"deepgram error: {frame.get('description', '')}")

        if self.on_text:
            await self.on_text(frame)

    async def _run_functions(self, calls: list[dict[str, Any]]) -> None:
        names: list[str] = []
        for call in calls:
            name = call.get("name", "")
            raw = call.get("arguments") or "{}"
            try:
                arguments = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                arguments = {}

            # Tools mutate shared state; keep them off the event loop thread.
            result = await asyncio.to_thread(run_tool, self.session.ctx, name, arguments)
            names.append(name)

            await self._send(
                {
                    "type": "FunctionCallResponse",
                    "id": call.get("id"),
                    "name": name,
                    "content": result,
                }
            )
            # Name only -- the browser must never see scores or arguments.
            if self.on_text:
                await self.on_text({"type": "AgentTool", "name": name})

        self._pending_tools.extend(names)
        self.session.ctx.tool_log.append(names)
        if self.session.ctx.is_finished():
            finish(self.session, self.session.ctx.stop_reason)
        save(self.session)
        await self._refresh_prompt()

    async def _refresh_prompt(self) -> None:
        """The prompt carries live state -- what is uncovered, what has been asked,
        how long is left. Anything that changes it must push the change."""
        await self._send({"type": "UpdatePrompt", "prompt": render_system_prompt(self.session.ctx)})

    # --- background tasks --------------------------------------------------------

    async def _keepalive(self, every: float = 5.0) -> None:
        while self.ws:
            await asyncio.sleep(every)
            if not await self._send({"type": "KeepAlive"}):
                return

    async def _quiet_watch(self, quiet_seconds: float = 6.0) -> None:
        """Treat a gap in traffic as the agent having finished.

        AgentAudioDone is the documented signal and it is not reliably delivered.
        Waiting on it alone deadlocks the next typed turn, so a gap with no frames
        at all -- audio included -- counts as finished too.
        """
        while self.ws:
            await asyncio.sleep(0.5)
            if self._last_frame and time.monotonic() - self._last_frame > quiet_seconds:
                self._idle.set()

    async def _watchdog(self) -> None:
        """Enforce the duration and turn caps on the voice path.

        The typed driver enforces these in its turn loop, which Deepgram never
        calls. Without this a voice interview has no time limit at all.
        """
        settings = get_settings()
        while self.ws and not self.session.ctx.is_finished():
            await asyncio.sleep(5)
            ctx = self.session.ctx
            if ctx.elapsed_seconds() >= settings.max_interview_seconds:
                reason = "duration_cap"
            elif ctx.turn_count >= settings.max_turns:
                reason = "turn_cap"
            else:
                continue
            finish(self.session, reason)
            await self._refresh_prompt()
            await self._send(
                {
                    "type": "InjectAgentMessage",
                    "content": (
                        "That is all the time we have. Thanks for walking me through your "
                        "work -- someone from the team will follow up with next steps."
                    ),
                }
            )
            return
