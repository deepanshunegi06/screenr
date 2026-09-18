"""One brain for the whole product: the model Deepgram already runs for us.

Everything that needed to think used to reach for a second provider -- Groq,
then Gemini, then whoever still had free quota that week. Two brains means two
sets of keys, two rate limits, and answers written in a voice that is not the
one candidates hear.

Deepgram has no plain completion endpoint, so this opens a Voice Agent socket
with no functions and no interview attached, says one thing, and reads the
reply. It is a voice API used for text, which is honest about what it is: the
alternative was a second vendor for the sake of one request.

The text path in `llm.py` stays for offline work -- the terminal interviewer and
the free eval sweep -- where spending agent-hours to test a prompt would be
absurd.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re

import websockets

from .config import get_settings
from .deepgram_driver import AGENT_URL, AUDIO_INPUT_RATE, AUDIO_OUTPUT_RATE

log = logging.getLogger(__name__)

# Long enough for a careful answer, short enough that a wedged socket does not
# hold a web request open.
REPLY_TIMEOUT = 90.0
# The agent sends its answer in pieces. This much silence means it has finished.
QUIET_SECONDS = 2.0
# Deepgram drops a socket that goes quiet while the model thinks.
KEEPALIVE_SECONDS = 5.0

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


def _settings(prompt: str) -> dict:
    s = get_settings()
    return {
        "type": "Settings",
        "tags": ["brain"],
        "mip_opt_out": True,
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": AUDIO_INPUT_RATE},
            "output": {"encoding": "linear16", "sample_rate": AUDIO_OUTPUT_RATE, "container": "none"},
        },
        "agent": {
            "listen": {"provider": {"type": "deepgram", "version": "v2", "model": "flux-general-en"}},
            "speak": {"provider": {"type": "deepgram", "version": "v2", "model": "flux-kit-en"}},
            "think": {
                "provider": {"type": s.voice_think_provider, "model": s.voice_think_model},
                "prompt": prompt,
            },
            "greeting": "",
        },
    }


async def think(prompt: str, message: str) -> str:
    """Ask the interview model one question. Raises ValueError with something
    worth showing a person when it cannot be reached."""
    settings = get_settings()
    if not settings.deepgram_api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set, so nothing can think here.")

    said: list[str] = []
    try:
        async with websockets.connect(
            AGENT_URL,
            additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
            max_size=None,
            ping_interval=None,
        ) as ws:
            await ws.send(json.dumps(_settings(prompt)))
            await ws.send(json.dumps({"type": "InjectUserMessage", "content": message}))

            # Deepgram closes a socket that sends nothing while it thinks, and a
            # long answer takes longer than that window. KeepAlive is their fix;
            # this is the same trick the interview driver uses.
            async def keepalive() -> None:
                with contextlib.suppress(Exception):
                    while True:
                        await asyncio.sleep(KEEPALIVE_SECONDS)
                        await ws.send(json.dumps({"type": "KeepAlive"}))

            beat = asyncio.create_task(keepalive())

            loop = asyncio.get_running_loop()
            deadline = loop.time() + REPLY_TIMEOUT
            try:
                while loop.time() < deadline:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=QUIET_SECONDS)
                    except TimeoutError:
                        if said:
                            break
                        continue
                    if isinstance(raw, bytes):
                        continue  # the spoken answer; not wanted here
                    frame = json.loads(raw)
                    if frame.get("type") == "ConversationText" and frame.get("role") == "assistant":
                        if text := (frame.get("content") or "").strip():
                            said.append(text)
                    elif frame.get("type") == "Error":
                        raise ValueError(f"Deepgram: {frame.get('description', 'unknown error')}")
            finally:
                beat.cancel()
                with contextlib.suppress(BaseException):
                    await beat
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"Couldn't reach the interview model: {type(exc).__name__}") from exc

    if not said:
        raise ValueError("The model returned nothing.")
    return " ".join(said)


async def think_json(prompt: str, message: str) -> dict:
    """Same, for a task whose answer has to be machine-readable.

    Deepgram's think step has no structured-output mode, so the shape is asked
    for in words and the fences a model likes to wrap JSON in are stripped here.
    """
    reply = await think(prompt, message)
    cleaned = _FENCE.sub("", reply).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("The model did not answer with JSON.")
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("The model's JSON was malformed.") from exc


def think_json_sync(prompt: str, message: str) -> dict:
    """For callers that are not async. Runs its own loop, so never call it from
    inside one -- FastAPI's sync endpoints run on a worker thread, which is fine."""
    with contextlib.suppress(RuntimeError):
        asyncio.get_running_loop()
        raise RuntimeError("think_json_sync called from inside an event loop; await think_json")
    return asyncio.run(think_json(prompt, message))
