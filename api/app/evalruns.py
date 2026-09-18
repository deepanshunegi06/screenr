"""Running the evals from the dashboard instead of from a terminal.

A committed report proves nothing on its own -- a reader has to take it on faith
that the file came from the code. A button that re-runs the scripted candidates
in front of them and rewrites the file settles that in about two minutes.

The run goes through the real Deepgram agent, not the text stand-in: a page that
claims "these are the real tool sequences" should mean the stack a candidate
actually talks to. It costs agent-hours, which is the right price for a claim
that has to hold up.

Runs happen on a worker thread with their own event loop, because a full pass
holds six sockets open for a couple of minutes. The page polls for progress.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from .config import get_settings

_LOCK = threading.Lock()
_STATE: dict = {"running": False, "done": 0, "total": 0, "startedAt": None, "error": None}

# All six interviews run at once, so a sweep takes as long as the longest one.
MAX_TURNS = 16


# Providers bury the useful sentence inside a dict they str() into the exception.
_PROVIDER_MESSAGE = re.compile(r"'message': ['\"](.+?)['\"],")


def _readable(exc: Exception) -> str:
    """The sentence a person can act on, not the whole provider payload."""
    text = str(exc)
    if match := _PROVIDER_MESSAGE.search(text):
        text = match.group(1)
    return f"{type(exc).__name__}: {text}"[:220]


def _key_present() -> bool:
    return bool(get_settings().deepgram_api_key)


def status() -> dict:
    with _LOCK:
        return dict(_STATE)


def start(results_path: Path) -> None:
    """Kick off a run. Raises ValueError with something worth showing a person."""
    if not _key_present():
        raise ValueError("DEEPGRAM_API_KEY is not set on the server, so the evals can't run here.")
    with _LOCK:
        if _STATE["running"]:
            raise ValueError("A run is already in progress.")
        _STATE.update(
            running=True, done=0, total=0, startedAt=datetime.now(UTC).isoformat(), error=None
        )
    threading.Thread(target=_work, args=(results_path,), daemon=True).start()


def _work(results_path: Path) -> None:
    try:
        import asyncio

        from evals import personas as p
        from evals.runner import build_report
        from evals.voice_runner import clear_stray_sessions, run_voice_interview

        clear_stray_sessions()
        with _LOCK:
            _STATE["total"] = len(p.ALL)

        async def sweep() -> tuple[list, list[dict]]:
            done_runs, failures = [], []

            async def one(persona):
                try:
                    return await run_voice_interview(persona, max_turns=MAX_TURNS)
                except Exception as exc:
                    # One socket failing must not throw away the other five. The
                    # failure is reported rather than hidden, because a report
                    # showing four of six with no explanation looks doctored.
                    return {"persona": persona.name, "reason": _readable(exc)}
                finally:
                    with _LOCK:
                        _STATE["done"] += 1

            for result in await asyncio.gather(*(one(persona) for persona in p.ALL)):
                (failures if isinstance(result, dict) else done_runs).append(result)
            return done_runs, failures

        runs, errors = asyncio.run(sweep())

        if runs:
            settings = get_settings()
            report = build_report(
                runs,
                model=settings.voice_think_model,
                provider=f"deepgram / {settings.voice_think_provider}",
                ran_at=datetime.now(UTC).isoformat(),
            )
            report["errors"] = errors
            _write(results_path, report)

        with _LOCK:
            if not runs:
                # Every persona failed -- almost always a rate limit or an outage.
                # The previous report stays: replacing real results with an empty
                # file because the provider was busy would lose the only evidence
                # there is.
                _STATE["error"] = (
                    f"Nothing ran, so the last report is unchanged. {errors[0]['reason']}"
                    if errors
                    else "Nothing ran."
                )
            else:
                _STATE["error"] = (
                    f"{len(errors)} of {len(p.ALL)} personas could not run: "
                    + ", ".join(e["persona"] for e in errors)
                    if errors
                    else None
                )
    except Exception as exc:
        with _LOCK:
            _STATE["error"] = _readable(exc)
    finally:
        with _LOCK:
            _STATE["running"] = False


def _write(path: Path, report: dict) -> None:
    """Replace the report in one step, so a poll never reads half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)
