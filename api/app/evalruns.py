"""Running the evals from the dashboard instead of from a terminal.

A committed report proves nothing on its own -- a reader has to take it on faith
that the file came from the code. A button that re-runs the four scripted
candidates in front of them and rewrites the file settles that in ninety
seconds.

Runs happen on a worker thread because a full pass is a few dozen LLM calls, far
too long to hold a request open. The page polls for progress.
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

# One persona is a handful of LLM calls; the whole set takes a minute or two on
# a fast provider and longer on a rate-limited free tier.
MAX_TURNS = 14


# Providers bury the useful sentence inside a dict they str() into the exception.
_PROVIDER_MESSAGE = re.compile(r"'message': ['\"](.+?)['\"],")


def _readable(exc: Exception) -> str:
    """The sentence a person can act on, not the whole provider payload."""
    text = str(exc)
    if match := _PROVIDER_MESSAGE.search(text):
        text = match.group(1)
    return f"{type(exc).__name__}: {text}"[:220]


def _key_present() -> bool:
    s = get_settings()
    return bool(s.groq_api_key or s.google_api_key or s.anthropic_api_key)


def status() -> dict:
    with _LOCK:
        return dict(_STATE)


def start(results_path: Path) -> None:
    """Kick off a run. Raises ValueError with something worth showing a person."""
    if not _key_present():
        raise ValueError("No LLM key is configured on the server, so the evals can't run here.")
    with _LOCK:
        if _STATE["running"]:
            raise ValueError("A run is already in progress.")
        _STATE.update(
            running=True, done=0, total=0, startedAt=datetime.now(UTC).isoformat(), error=None
        )
    threading.Thread(target=_work, args=(results_path,), daemon=True).start()


def _work(results_path: Path) -> None:
    try:
        from evals import personas as p
        from evals.runner import build_report, run_interview

        with _LOCK:
            _STATE["total"] = len(p.ALL)

        runs = []
        errors: list[dict] = []
        for persona in p.ALL:
            try:
                runs.append(run_interview(persona, max_turns=MAX_TURNS))
            except Exception as exc:
                # A rate limit on persona three must not throw away personas one
                # and two. The failure is reported rather than hidden, because a
                # report showing four of six with no explanation looks doctored.
                errors.append({"persona": persona.name, "reason": _readable(exc)})
            with _LOCK:
                _STATE["done"] += 1

        if runs:
            settings = get_settings()
            report = build_report(
                runs,
                model=settings.llm_model,
                provider=settings.llm_provider,
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
