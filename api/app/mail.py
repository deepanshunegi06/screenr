"""Sending the invite, for real.

A link a recruiter has to copy into their own mail client is a link half of them
will forget to send. This puts the invite in the candidate's inbox.

Three ways out, tried in order of what each can actually reach.

Resend refuses every recipient except the account owner until a domain is
verified -- a recipient restriction, not a sender one -- so with no domain it
reaches exactly one person. Plain SMTP has no such rule and a Gmail app password
sends to anyone, but platform hosts block outbound SMTP to keep spammers off
their address space: on Railway port 587 fails with "Network is unreachable"
before a packet leaves the container.

Brevo is the one with neither problem. It is an HTTPS API, so no firewall stands
in front of it, and it verifies a single sender address with a code emailed to
that address rather than with DNS records, so no domain is needed to mail a
stranger. It goes first for that reason, SMTP second for when it is the only one
configured, and Resend last because it can only ever reach one inbox.

Failures are ordinary rather than exceptional here, and the reason comes straight
back to the recruiter instead of being swallowed. "It didn't arrive" is a much
worse outcome than "it wasn't sent, here's why".
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

RESEND_URL = "https://api.resend.com/emails"
BREVO_URL = "https://api.brevo.com/v3/smtp/email"

# Set once the SMTP port has proved unreachable from wherever this is running.
# A blocked port does not unblock itself, and paying the connect timeout on every
# send afterwards would put a fifteen-second spinner in front of the recruiter.
_smtp_blocked = False


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

    if settings.brevo_api_key:
        return await _send_brevo(to, subject, text, html)

    global _smtp_blocked
    if settings.smtp_user and not _smtp_blocked:
        try:
            return await asyncio.to_thread(_send_smtp, to, subject, text, html)
        except ValueError as exc:
            if not settings.resend_api_key:
                raise
            # A network-level failure is the port being closed to us, which will
            # stay closed. Credentials being wrong is not, so that one is retried.
            if "unreachable" in str(exc) or "timed out" in str(exc):
                _smtp_blocked = True
            # Worth a line in the log: the recruiter sees a delivered mail and
            # would otherwise never learn that the preferred route is dead.
            log.warning("smtp failed, falling back to resend: %s", exc)
    if settings.resend_api_key:
        return await _send_resend(to, subject, text, html)
    raise ValueError("No mail is configured: set BREVO_API_KEY, SMTP_USER or RESEND_API_KEY.")


async def _send_brevo(to: str, subject: str, text: str, html: str) -> str:
    settings = get_settings()
    label, address = parseaddr(settings.mail_from)
    payload = {
        # The sender address has to be one verified in the Brevo account, or the
        # send is refused -- which is the trade for not having to own a domain.
        "sender": {"name": label or "screenr", "email": address or settings.smtp_user},
        "to": [{"email": to}],
        "subject": subject,
        "textContent": text,
        "htmlContent": html,
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                BREVO_URL, json=payload, headers={"api-key": settings.brevo_api_key}
            )
    except httpx.HTTPError as exc:
        raise ValueError(f"Couldn't reach Brevo: {type(exc).__name__}") from exc

    body: dict = {}
    try:
        body = response.json()
    except ValueError:
        pass
    if response.status_code >= 400:
        raise ValueError(body.get("message") or f"Brevo refused it ({response.status_code}).")
    return str(body.get("messageId", ""))


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
        # 465 is implicit TLS, 587 is STARTTLS. Hosts that block one sometimes
        # allow the other, so both are worth supporting.
        if settings.smtp_port == 465:
            with smtplib.SMTP_SSL(
                settings.smtp_host, 465, timeout=8, context=ssl.create_default_context()
            ) as server:
                server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(message)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=8) as server:
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
                RESEND_URL,
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
