# 004 — One hardcoded recruiter account in v1

**Status:** accepted, with a known expiry

## Context

Real recruiter accounts mean a provider, an invite flow, password reset, sessions,
and a roles model. That is a day of work that demonstrates nothing this project is
trying to demonstrate.

## Decision

One recruiter, credentials in env, a signed JWT on login. Candidates never get an
account at all — they arrive on a signed, expiring link, which is also better for
them: no signup between a candidate and an interview.

## Consequences

This is a real gap, not a design position. Multiple recruiters, an audit trail
tied to an identity, and anything resembling tenancy all need a proper provider.

Clerk's free tier covers it in roughly an hour when the time comes. What is
already in place: every scorecard decision is written with the acting user's
identifier, so the audit log does not need reshaping — it needs more than one
possible value in that column.
