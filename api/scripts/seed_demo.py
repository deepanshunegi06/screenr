"""Making a deployed instance look like a hiring pipeline instead of a test harness.

A fresh deployment shows an empty table, and one that has been demoed twice shows
rows called "test 3" and "camera eval" -- artifacts of proving the product works,
which say nothing about what it does. This clears those out and leaves four
candidates in their place: two roles, an obviously stronger and an obviously
weaker candidate in each, so a scorecard comparison has something to separate.

The résumés are the point. They are written so that `roles.extract_claims` finds
real claims in them -- specific numbers, named technologies, one decision per line
-- because a candidate whose résumé yields nothing to probe makes the interviewer
look generic, which is the opposite of the demo.

It goes over HTTP rather than touching the store, so it runs against a deployed
instance from a laptop and passes through the same validation a recruiter would.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

import httpx

# Substrings that mark a row as something a developer made, not a recruiter. The
# list is deliberately short and literal: --wipe deletes what it matches, and this
# may run against an instance that has real candidates in it.
TEST_MARKERS = ("test", "demo", "eval+", "gaze", "proctor", "camera", "persist", "shot", "look")


def _looks_like_test(name: str, email: str) -> bool:
    blob = f"{name} {email}".lower()
    return any(marker in blob for marker in TEST_MARKERS)


@dataclass(frozen=True)
class Candidate:
    name: str
    email: str
    rubric: str
    resume: str


CANDIDATES = [
    Candidate(
        name="Ananya Deshmukh",
        email="ananya.deshmukh@nitt.edu",
        rubric="backend_intern",
        resume="""Ananya Deshmukh
Final year B.Tech Computer Science, NIT Tiruchirappalli

Built the check-in backend for the campus fest, 4,100 registrations across three days.
Designed the Postgres schema behind it: one table for passes, one for scans, unique on (pass_id, gate).
Implemented idempotent check-in so a volunteer double-tapping the scanner could not create two entries.
Migrated from SQLite to Postgres on the second morning, after write locks started timing out at the gate.
Deployed on a 2 GB droplet with gunicorn behind nginx, no containers and no orchestration.
Automated a nightly reconciliation of scan counts against ticket sales that mailed the mismatches.
Built a retrieval bot over past fest FAQs; chunking at 400 characters lost answers spanning headings.
""",
    ),
    Candidate(
        name="Rohit Bansal",
        email="rohit.bansal2022@vitstudent.ac.in",
        rubric="backend_intern",
        resume="""Rohit Bansal
B.Tech Information Technology, VIT Vellore, CGPA 7.9

Developed a REST API for a food delivery application using Node.js and Express.
Integrated a payment gateway in sandbox mode and handled the webhook callbacks.
Created the database schema in MongoDB with collections for users, orders and restaurants.
Built a college enquiry chatbot using the OpenAI API and a list of 40 frequently asked questions.
Deployed the project on Render's free tier, where it sleeps after fifteen minutes without traffic.
Implemented JWT authentication by following a tutorial series and adapting it to the project.
""",
    ),
    Candidate(
        name="Meghna Pillai",
        email="meghna.pillai@pes.edu",
        rubric="frontend_intern",
        resume="""Meghna Pillai
Third year B.Tech Computer Science, PES University, Bengaluru

Built the seat-selection screen for the campus shuttle booking app, around 900 riders a week.
Migrated the seat grid to a single reducer after the React Profiler showed 380 re-renders per tap.
Implemented keyboard navigation for the grid; arrow keys skipped the aisle entirely under NVDA.
Designed the loading, empty and error states for booking history, with a retry that cannot double-book.
Optimised first paint from 4.2s to 1.4s on throttled 3G by splitting the route and dropping an icon font.
Shipped a dark theme built on CSS custom properties rather than a second stylesheet.
""",
    ),
    Candidate(
        name="Aarav Krishnan",
        email="aarav.krishnan@srmist.edu.in",
        rubric="frontend_intern",
        resume="""Aarav Krishnan
B.Tech Computer Science and Engineering, SRM Institute of Science and Technology

Built a personal portfolio site and a weather dashboard in React during a summer course.
Implemented a to-do application with local storage and drag-and-drop reordering.
Created responsive layouts with Tailwind CSS and Bootstrap across three class projects.
Integrated a public movie API into a search page with a loading spinner and a results grid.
Designed the interface in Figma from a community template before building it.
""",
    ),
]

# A seeded row that matched the wipe filter would be deleted by the next run of
# this script, which is a confusing way to lose a demo ten minutes before it starts.
assert not [c for c in CANDIDATES if _looks_like_test(c.name, c.email)]


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def _explain(exc: httpx.HTTPStatusError) -> str:
    """The API's own message, which names the actual problem far better than the status."""
    try:
        return str(exc.response.json().get("detail", exc.response.text))[:300]
    except ValueError:
        return f"{exc.response.status_code} {exc.response.text[:200]}"


def wipe(client: httpx.Client, rows: list[dict]) -> int:
    removed = 0
    for row in rows:
        if not _looks_like_test(row.get("candidate", ""), row.get("candidateEmail", "")):
            continue
        client.delete(f"/sessions/{row['id']}").raise_for_status()
        print(f"  deleted  {row.get('candidate') or '(no name)'} <{row.get('candidateEmail', '')}>")
        removed += 1
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--web", default="http://localhost:3000", help="origin for the invite links")
    parser.add_argument("--email", default="recruiter@screenr.local")
    parser.add_argument("--password", default="screenr2026")
    parser.add_argument("--wipe", action="store_true", help="first delete rows that look like test data")
    args = parser.parse_args()

    web = args.web.rstrip("/")
    with httpx.Client(base_url=args.api.rstrip("/"), timeout=30) as client:
        try:
            response = client.post("/auth/login", json={"email": args.email, "password": args.password})
            response.raise_for_status()
            client.headers["Authorization"] = f"Bearer {response.json()['token']}"

            # Fail before creating anything if a rubric is missing, rather than
            # halfway through and leaving two candidates seeded out of four.
            titles = {r["key"]: r["title"] for r in client.get("/roles").raise_for_status().json()}
            missing = {c.rubric for c in CANDIDATES} - titles.keys()
            if missing:
                _fail(f"this instance has no rubric named {', '.join(sorted(missing))}")

            rows = client.get("/sessions").raise_for_status().json()
            if args.wipe:
                print(f"Wiping test rows from {len(rows)} existing sessions:")
                count = wipe(client, rows)
                print(f"  {count} deleted, {len(rows) - count} left alone\n")
                rows = client.get("/sessions").raise_for_status().json()

            taken = {str(r.get("candidateEmail", "")).lower() for r in rows}
            seeded: list[tuple[Candidate, str]] = []
            for candidate in CANDIDATES:
                if candidate.email.lower() in taken:
                    print(f"skipping {candidate.email}: already invited")
                    continue
                created = client.post(
                    "/sessions",
                    json={
                        "candidateEmail": candidate.email,
                        "candidateName": candidate.name,
                        "rubric": candidate.rubric,
                        "resumeText": candidate.resume,
                    },
                )
                created.raise_for_status()
                seeded.append((candidate, created.json()["inviteToken"]))
        except httpx.HTTPStatusError as exc:
            _fail(_explain(exc))
        except httpx.HTTPError as exc:
            _fail(f"couldn't reach {args.api}: {type(exc).__name__}")

    if not seeded:
        print("\nNothing to seed: every candidate was already there.")
        return

    print(f"\nSeeded {len(seeded)} candidates:\n")
    for candidate, token in seeded:
        print(f"  {candidate.name:<18} {candidate.email:<36} {titles[candidate.rubric]}")
        print(f"  {web}/interview/{token}\n")


if __name__ == "__main__":
    main()
