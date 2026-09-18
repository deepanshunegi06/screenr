"""The browser's socket.

One WebSocket per interview. Audio goes browser -> here -> Deepgram, and the
agent's voice comes back the same way. Text frames are forwarded too, so the page
can show the live transcript and what the agent is doing.

Deepgram's key never reaches the browser. That is the only reason this relay
exists rather than the page connecting to Deepgram directly.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import store
from .auth import candidate_session_id
from .deepgram_driver import BOOTSTRAP, RECONNECT, DeepgramInterview

log = logging.getLogger(__name__)
router = APIRouter()

# What the browser is allowed to see. A candidate must never receive scores,
# rubric internals, or the arguments the agent passed to a tool.
FORWARDED = {
    "ConversationText",
    "UserStartedSpeaking",
    "AgentThinking",
    "AgentStartedSpeaking",
    "AgentAudioDone",
    "AgentTool",
    "Error",
}

# Integrity events the browser may report. Anything else is dropped.
INTEGRITY_KINDS = {
    "tab_hidden",
    "window_blur",
    "fullscreen_exit",
    "paste",
    "second_screen",
    "no_face",
    "multiple_faces",
    "looking_away",
    "camera_lost",
    "audio_device_changed",
}

# Newest connection wins. A second tab or a reload whose old socket has not
# closed yet would otherwise run two agents against one interview.
_LIVE: dict[str, DeepgramInterview] = {}


async def _send_safely(socket: WebSocket, frame: dict) -> None:
    with contextlib.suppress(Exception):
        await socket.send_json(frame)


async def _reject(socket: WebSocket, reason: str) -> None:
    await _send_safely(socket, {"type": "Rejected", "reason": reason})
    with contextlib.suppress(Exception):
        await socket.close()


@router.websocket("/ws/interview/{token}")
async def interview_socket(socket: WebSocket, token: str) -> None:
    await socket.accept()

    try:
        session_id = candidate_session_id(token)
    except Exception:
        await _reject(socket, "This link is no longer valid.")
        return

    session = store.get(session_id)
    if session is None:
        await _reject(socket, "This interview no longer exists.")
        return
    if not session.consented:
        await _reject(socket, "Consent is needed first.")
        return
    if session.ctx.is_finished():
        await _send_safely(socket, {"type": "Finished"})
        with contextlib.suppress(Exception):
            await socket.close()
        return

    if previous := _LIVE.pop(session.id, None):
        await previous.close()

    # The clock starts now, before the first prompt is rendered -- otherwise an
    # invite opened twenty minutes after it was created opens on "time is up".
    resuming = bool(session.transcript)
    store.start(session)

    dg = DeepgramInterview(session)
    _LIVE[session.id] = dg

    async def to_browser_audio(chunk: bytes) -> None:
        with contextlib.suppress(Exception):
            await socket.send_bytes(chunk)

    async def to_browser_text(frame: dict) -> None:
        if frame.get("type") in FORWARDED:
            await _send_safely(socket, frame)

    dg.on_audio = to_browser_audio
    dg.on_text = to_browser_text

    try:
        await dg.connect(resume=resuming)
    except Exception as exc:
        log.warning("deepgram connect failed for %s: %r", session.id, exc)
        _LIVE.pop(session.id, None)
        await _reject(socket, "Voice isn't available right now. Try again in a moment.")
        return

    pump = asyncio.create_task(dg.pump())

    def pump_done(task: asyncio.Task) -> None:
        # The candidate must hear about the end from us, not from silence -- in
        # typed mode there is no inbound audio to wake the receive loop below.
        if task.cancelled():
            return
        if exc := task.exception():
            log.warning("pump failed for %s: %r", session.id, exc)
        if session.ctx.is_finished():
            store.finish(session, session.ctx.stop_reason)
            frame = {"type": "Finished"}
        else:
            frame = {"type": "Rejected", "reason": "The interviewer disconnected. Reload to continue."}
        asyncio.ensure_future(_send_safely(socket, frame))

    pump.add_done_callback(pump_done)

    await _send_safely(socket, {"type": "Ready", "resumed": resuming})

    last_speaker = session.transcript[-1]["speaker"] if session.transcript else None
    if not resuming:
        # Nothing is scripted: the first question comes from the rubric and this
        # candidate's resume.
        await dg.inject_text(BOOTSTRAP)
    elif last_speaker == "candidate":
        # They answered, then the line dropped. Re-engage rather than waiting on
        # both sides for the other to speak.
        await dg.inject_text(RECONNECT)

    try:
        while True:
            message = await socket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if (chunk := message.get("bytes")) is not None:
                await dg.send_audio(chunk)
                continue

            if (text := message.get("text")) is not None:
                await _handle_browser_text(dg, session, text, socket)

            if session.ctx.is_finished() and not dg.open:
                break
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        with contextlib.suppress(BaseException):
            await pump
        await dg.close()
        if _LIVE.get(session.id) is dg:
            _LIVE.pop(session.id, None)
        with contextlib.suppress(Exception):
            await socket.close()


async def _handle_browser_text(
    dg: DeepgramInterview, session: store.Session, raw: str, socket: WebSocket
) -> None:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return

    kind = payload.get("type")

    if kind == "Typed":
        # Fallback when a candidate's microphone fails.
        answer = (payload.get("content") or "").strip()[:4000]
        if answer:
            await dg.inject_text(answer)

    elif kind == "End":
        # "removed" when the warning limit was reached, "candidate_ended" when
        # they chose to stop. Either way the answer to the browser is immediate.
        reason = "removed" if payload.get("reason") == "violations" else "candidate_ended"
        await dg.request_end(reason)
        await _send_safely(socket, {"type": "Finished", "reason": reason})

    elif kind == "Integrity":
        flag_kind = str(payload.get("kind", ""))
        if flag_kind in INTEGRITY_KINDS:
            store.add_integrity_flag(session, flag_kind, str(payload.get("detail", ""))[:200])


@router.get("/interview/{token}/state")
def interview_state(token: str) -> dict:
    """Lets a reconnecting page redraw what has happened so far."""
    session = store.get(candidate_session_id(token))
    if session is None:
        return {"exists": False}
    regular = [s for s in session.ctx.skills if not s.cross_cutting]
    return {
        "exists": True,
        "candidate": session.candidate_name,
        "roleTitle": session.ctx.role_title,
        "finished": session.ctx.is_finished(),
        "elapsedSeconds": session.duration_seconds(),
        "transcript": [
            {"at": t["at"], "speaker": t["speaker"], "text": t["text"]}
            for t in session.transcript
            if t["speaker"] in ("agent", "candidate")
        ],
        # Progress the candidate is allowed to see: how far along, not how well.
        "skillsCovered": len(regular) - len(session.ctx.uncovered_skills()),
        "skillsTotal": len(regular),
    }
