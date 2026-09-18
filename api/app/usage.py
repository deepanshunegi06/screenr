"""What an interview actually cost.

Every socket is opened with the session id as a Deepgram tag, so their usage
breakdown can be filtered down to one interview. This reports measured usage
rather than an estimate from our own timers -- if the socket stayed open while
nobody spoke, that shows up here and not in a duration counter.

Failures are soft on purpose: a missing cost line is a worse reason to break a
scorecard than no reason at all.
"""

from __future__ import annotations

import httpx

from .config import get_settings

USAGE_URL = "https://api.deepgram.com/v1/projects/{project}/usage/breakdown"

# Voice Agent list price. Kept here as one named constant so the number on a
# scorecard can be traced to something, rather than appearing by magic.
AGENT_USD_PER_HOUR = 4.50


async def session_usage(session_id: str) -> dict[str, float] | None:
    settings = get_settings()
    if not (settings.deepgram_api_key and settings.deepgram_project_id):
        return None

    url = USAGE_URL.format(project=settings.deepgram_project_id)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                url,
                params={"tag": session_id},
                headers={"Authorization": f"Token {settings.deepgram_api_key}"},
            )
            response.raise_for_status()
            results = response.json().get("results", [])
    except (httpx.HTTPError, ValueError):
        return None

    if not results:
        return None

    agent_hours = sum(float(r.get("agent_hours") or 0) for r in results)
    return {
        "agentHours": round(agent_hours, 5),
        "ttsCharacters": sum(int(r.get("tts_characters") or 0) for r in results),
        "requests": sum(int(r.get("requests") or 0) for r in results),
        "costUsd": round(agent_hours * AGENT_USD_PER_HOUR, 4),
    }


async def project_balance() -> float | None:
    settings = get_settings()
    if not (settings.deepgram_api_key and settings.deepgram_project_id):
        return None
    url = f"https://api.deepgram.com/v1/projects/{settings.deepgram_project_id}/balances"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                url, headers={"Authorization": f"Token {settings.deepgram_api_key}"}
            )
            response.raise_for_status()
            balances = response.json().get("balances", [])
    except (httpx.HTTPError, ValueError):
        return None
    return round(sum(float(b.get("amount") or 0) for b in balances), 4) if balances else None
