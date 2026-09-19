"""Sending the invite, for real.

A link a recruiter has to copy into their own mail client is a link half of them
will forget to send. This puts the invite in the candidate's inbox.

Two ways out, because the obvious one has a catch. Resend will not deliver
anywhere except the account owner's address until a domain is verified -- not a
sender restriction, a recipient one -- so without a domain it can reach exactly
one person. Plain SMTP has no such rule: a Gmail app password sends to anyone,
from an address that already exists, with no DNS to configure.

Whichever is configured, failures are ordinary rather than exceptional here, and
the reason comes straight back to the recruiter instead of being swallowed. "It
didn't arrive" is a much worse outcome than "it wasn't sent, here's why".
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

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
    """Send one invite. Returns a message id.

    SMTP wins when it is configured, because it is the one that can reach a real
    candidate. Raises ValueError carrying the provider's own explanation, which
    is usually the actionable one.
    """
    settings = get_settings()
    subject = f"Your screening interview for {role}"
    text = _text(candidate, role, minutes, link)
    html = _html(candidate, role, minutes, link)

    if settings.smtp_user:
        return await asyncio.to_thread(_send_smtp, to, subject, text, html)
    if settings.resend_api_key:
        return await _send_resend(to, subject, text, html)
    raise ValueError("No mail is configured: set SMTP_USER or RESEND_API_KEY.")


def _send_smtp(to: str, subject: str, text: str, html: str) -> str:
    """Blocking on purpose -- smtplib is, and it runs on a worker thread."""
    settings = get_settings()

    message = EmailMessage()
    message["Subject"] = subject
    # The envelope sender has to be the authenticated account whatever MAIL_FROM
    # says, or Gmail rewrites it and the display name is lost.
    label = parseaddr(settings.mail_from)[0] or "screenr"
    message["From"] = formataddr((label, settings.smtp_user))
    message["To"] = to
    message.set_content(text)
    message.add_alternative(html, subtype="html")

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        raise ValueError(
            "The mail server rejected those credentials. For Gmail this must be an "
            "app password from myaccount.google.com/apppasswords, not the account password."
        ) from exc
    except (OSError, smtplib.SMTPException) as exc:
        raise ValueError(f"Couldn't send through {settings.smtp_host}: {exc}") from exc

    return f"smtp:{settings.smtp_user}"


async def _send_resend(to: str, subject: str, text: str, html: str) -> str:
    settings = get_settings()
    payload = {
        "from": settings.mail_from,
        "to": [to],
        "subject": subject,
        "text": text,
        "html": html,
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
