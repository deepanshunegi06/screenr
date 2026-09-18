"""Second-voice detection.

The Voice Agent API will not diarize -- `diarize` and `multichannel` are both
rejected on `agent.listen.provider`, verified against the live socket. Deepgram's
ordinary streaming endpoint does support it, so the candidate's audio is forked:
the same PCM goes to the agent, which runs the interview, and to `/v1/listen`
with `diarize_model=v1`, which does nothing but label who is speaking.

When a second speaker label appears, that is one note on the recruiter's
timeline. It is not proof of anything -- a television, a housemate, or a
diarizer mistake all look the same from here -- and it never reaches scoring.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable

import websockets

from .config import get_settings

log = logging.getLogger(__name__)

LISTEN_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3"
    "&encoding=linear16"
    "&sample_rate={rate}"
    "&channels=1"
    "&diarize_model=v1"
    "&punctuate=false"
    "&interim_results=false"
)

# One or two words attributed elsewhere is the diarizer being unsure at a turn
# boundary, not another person in the room.
MIN_WORDS = 4

# One note is enough. A second voice present throughout should not produce fifty.
REPORT_LIMIT = 3


class SecondVoiceWatch:
    """Forks audio to Deepgram's streaming transcriber purely to count speakers."""

    def __init__(self, sample_rate: int, on_detected: Callable[[str], Awaitable[None]]) -> None:
        self.sample_rate = sample_rate
        self.on_detected = on_detected
        self.ws: websockets.ClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._speakers: set[int] = set()
        self._reports = 0

    async def start(self) -> bool:
        settings = get_settings()
        if not settings.deepgram_api_key:
            return False
        try:
            self.ws = await websockets.connect(
                LISTEN_URL.format(rate=self.sample_rate),
                additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
                max_size=None,
                ping_interval=None,
            )
        except Exception as exc:
            log.warning("second-voice watch could not connect: %r", exc)
            return False
        self._task = asyncio.create_task(self._read())
        return True

    async def feed(self, chunk: bytes) -> None:
        if not self.ws:
            return
        try:
            await self.ws.send(chunk)
        except websockets.ConnectionClosed:
            self.ws = None

    async def _read(self) -> None:
        assert self.ws is not None
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    continue
                with contextlib.suppress(ValueError, KeyError):
                    await self._handle(json.loads(message))
        except websockets.ConnectionClosed:
            pass

    async def _handle(self, frame: dict) -> None:
        alternatives = frame.get("channel", {}).get("alternatives", [])
        if not alternatives:
            return
        words = alternatives[0].get("words") or []

        counts: dict[int, int] = {}
        for word in words:
            speaker = word.get("speaker")
            if speaker is not None:
                counts[speaker] = counts.get(speaker, 0) + 1

        for speaker, count in counts.items():
            if count < MIN_WORDS or speaker in self._speakers:
                continue
            self._speakers.add(speaker)
            # Speaker 0 is the candidate: the first voice the stream hears.
            if len(self._speakers) > 1 and self._reports < REPORT_LIMIT:
                self._reports += 1
                await self.on_detected(
                    f"A second voice was transcribed ({len(self._speakers)} speakers so far)"
                )

    async def close(self) -> None:
        if self.ws:
            ws, self.ws = self.ws, None
            with contextlib.suppress(Exception):
                await ws.send(json.dumps({"type": "CloseStream"}))
                await ws.close()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task
            self._task = None
