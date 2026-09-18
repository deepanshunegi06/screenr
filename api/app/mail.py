"""Sending the invite, for real.

A link a recruiter has to copy into their own mail client is a link half of them
will forget to send. This puts the invite in the candidate's inbox.

Resend refuses to send anywhere except the account owner's address until a
domain is verified, so failures here are ordinary rather than exceptional. The
reason comes straight back to the recruiter instead of being swallowed: "it
didn't arrive" is a much worse outcome than "it wasn't sent, here's why".
"""

from __future__ import annotations

import logging

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

SEND_URL = "https://api.resend.com/emails"


def _text(candidate: str, role: str, minutes: int, link: str) -> str:
    """Plain words. An invite that reads like marketing gets treated like it."""
    hello = f"Hi {candidate.split(' ')[0]}," if candidate.strip() else "Hi,"
    return f"""{hello}

You've been invited to a first-round screening interview for {role}.

It runs in your browser and takes about {minutes} minutes. You'll talk with an
AI interviewer that asks follow-up questions based on your answers, so there's
no fixed list to prepare for. It records what you say and points every note at
something you actually said. It doesn't make the decision -- a person reads the
transcript afterwards and makes the call.

Start whenever you're ready:
{link}

A few things worth knowing before you click:
- You'll need a working microphone. If it fails, you can type instead.
- It opens in full screen. Switching tabs or windows gives you a warning, and
  after three the interview ends early.
- Saying "I don't know" is fine. It scores better than a confident guess.

The link is yours alone -- please don't forward it.
"""


def _html(candidate: str, role: str, minutes: int, link: str) -> str:
    hello = f"Hi {candidate.split(' ')[0]}," if candidate.strip() else "Hi,"
    body = (
        "font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;"
        "line-height:1.6;color:#1a1814;max-width:520px"
    )
    button = (
        "background:#1a1814;color:#fff;padding:11px 20px;border-radius:5px;"
        "text-decoration:none;font-weight:500"
    )
    note = "color:#867f74;font-size:13px;border-top:1px solid #e3e0d9;padding-top:14px;margin-top:28px"
    return f"""<div style="{body}">
<p>{hello}</p>
<p>You've been invited to a first-round screening interview for <strong>{role}</strong>.</p>
<p>It runs in your browser and takes about {minutes} minutes. You'll talk with an AI
interviewer that asks follow-up questions based on your answers, so there's no fixed
list to prepare for. It records what you say and points every note at something you
actually said. It doesn't make the decision — a person reads the transcript afterwards
and makes the call.</p>
<p style="margin:28px 0">
  <a href="{link}" style="{button}">Start the interview</a>
</p>
<p style="color:#55504a;font-size:14px">A few things worth knowing before you click:</p>
<ul style="color:#55504a;font-size:14px;padding-left:18px">
  <li>You'll need a working microphone. If it fails, you can type instead.</li>
  <li>It opens in full screen. Switching tabs or windows gives you a warning, and
      after three the interview ends early.</li>
  <li>Saying "I don't know" is fine. It scores better than a confident guess.</li>
</ul>
<p style="{note}">
The link is yours alone — please don't forward it.</p>
</div>"""


async def send_invite(
    *, to: str, candidate: str, role: str, minutes: int, link: str
) -> str:
    """Send one invite. Returns the provider's message id.

    Raises ValueError carrying the provider's own explanation, which is usually
    the actionable one -- an unverified domain, or a sandbox restriction.
    """
    settings = get_settings()
    if not settings.resend_api_key:
        raise ValueError("RESEND_API_KEY is not set, so invites can't be emailed from here.")

    payload = {
        "from": settings.mail_from,
        "to": [to],
        "subject": f"Your screening interview for {role}",
        "text": _text(candidate, role, minutes, link),
        "html": _html(candidate, role, minutes, link),
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                SEND_URL,
                json=payload,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            )
    except httpx.HTTPError as exc:
        raise ValueError(f"Couldn't reach the mail service: {type(exc).__name__}") from exc

    body = {}
    try:
        body = response.json()
    except ValueError:
        pass

    if response.status_code >= 400:
        # Resend's message names the fix ("verify a domain at resend.com/domains"),
        # so it is worth more to the recruiter than anything we could write.
        raise ValueError(body.get("message") or f"The mail service refused it ({response.status_code}).")

    return str(body.get("id", ""))
