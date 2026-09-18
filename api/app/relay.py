"""The browser's socket.

One WebSocket per interview. Audio goes browser -> here -> Deepgram, and the
agent's voice comes back the same way. Text frames are forwarded too, so the page
can show the live transcript.

Deepgram's key never reaches the browser. That is the only reason this relay
exists rather than the page connecting to Deepgram directly.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import store
from .auth import candidate_session_id
from .deepgram_driver import BOOTSTRAP, DeepgramInterview
from .scoring import build_scorecard

router = APIRouter()

# What the browser is allowed to see. A candidate must never receive scores,
# rubric internals, or the arguments the agent passed to a tool.
FORWARDED = {
    "ConversationText",
    "UserStartedSpeaking",
    "AgentThinking",
    "AgentStartedSpeaking",
    "AgentAudioDone",
    "Error",
}


@router.websocket("/ws/interview/{token}")
async def interview_socket(socket: WebSocket, token: str) -> None:
    await socket.accept()

    try:
        session_id = candidate_session_id(token)
    except Exception:
        await socket.send_json({"type": "Rejected", "reason": "This link is no longer valid."})
        await socket.close()
        return

    session = store.get(session_id)
    if session is None:
        await socket.send_json({"type": "Rejected", "reason": "This interview no longer exists."})
        await socket.close()
        return
    if not session.consented:
        await socket.send_json({"type": "Rejected", "reason": "Consent is needed first."})
        await socket.close()
        return
    if session.ctx.is_finished():
        await socket.send_json({"type": "Finished"})
        await socket.close()
        return

    dg = DeepgramInterview(session)

    async def to_browser_audio(chunk: bytes) -> None:
        with contextlib.suppress(Exception):
            await socket.send_bytes(chunk)

    async def to_browser_text(frame: dict) -> None:
        if frame.get("type") not in FORWARDED:
            return
        with contextlib.suppress(Exception):
            await socket.send_json(frame)

    dg.on_audio = to_browser_audio
    dg.on_text = to_browser_text

    # Resume if this candidate has been here before -- a dropped connection
    # should cost them a few seconds, not the interview.
    resuming = bool(session.transcript)
    try:
        await dg.connect(resume=resuming)
    except Exception as exc:
        await socket.send_json({"type": "Rejected", "reason": f"Could not start: {exc}"})
        await socket.close()
        return

    session.started = True
    dg.start_watchdog()
    dg.start_quiet_watch()
    pump = asyncio.create_task(dg.pump())

    await socket.send_json({"type": "Ready", "resumed": resuming})

    if not resuming:
        # The agent opens. Nothing is scripted -- the first question comes from
        # the rubric and this candidate's resume.
        await dg.inject_text(BOOTSTRAP)

    try:
        while True:
            message = await socket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if (chunk := message.get("bytes")) is not None:
                await dg.send_audio(chunk)
                continue

            if (text := message.get("text")) is not None:
                await _handle_browser_text(dg, session, text)

            if session.ctx.is_finished():
                await socket.send_json({"type": "Finished"})
                break

    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        await dg.close()
        with contextlib.suppress(Exception):
            await socket.close()


async def _handle_browser_text(dg: DeepgramInterview, session: store.Session, raw: str) -> None:
    import json

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return

    kind = payload.get("type")

    if kind == "Typed":
        # Fallback when a candidate's microphone fails.
        answer = (payload.get("content") or "").strip()
        if answer:
            await dg.inject_text(answer)

    elif kind == "Integrity":
        # Stored beside the transcript for a human. Never reaches scoring.
        store.add_integrity_flag(
            session, str(payload.get("kind", "unknown")), str(payload.get("detail", ""))
        )


@router.get("/interview/{token}/state")
def interview_state(token: str) -> dict:
    """Lets a reconnecting page redraw what has happened so far."""
    session = store.get(candidate_session_id(token))
    if session is None:
        return {"exists": False}
    return {
        "exists": True,
        "candidate": session.candidate_name,
        "roleTitle": session.ctx.role_title,
        "finished": session.ctx.is_finished(),
        "elapsedSeconds": int(session.ctx.elapsed_seconds()),
        "transcript": [
            {"at": t["at"], "speaker": t["speaker"], "text": t["text"]}
            for t in session.transcript
            if t["speaker"] in ("agent", "candidate")
        ],
        # Progress the candidate is allowed to see: how far along, not how well.
        "skillsCovered": len(build_scorecard(session.ctx)["skills"])
        - len(session.ctx.uncovered_skills()),
        "skillsTotal": len(session.ctx.skills),
    }
