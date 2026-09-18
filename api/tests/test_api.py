"""The HTTP surface, with no LLM and no network.

Every test here runs against a throwaway SQLite file, so it can create, decide,
close and delete sessions freely.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="screenr-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["DEMO_MODE"] = "true"
os.environ["RECRUITER_EMAIL"] = "r@test.local"
os.environ["RECRUITER_PASSWORD"] = "changeme"

# Settings are cached per process and the store connects at import; both have to
# see the env above, so anything already imported is dropped first.
for name in [m for m in sys.modules if m == "app" or m.startswith("app.")]:
    del sys.modules[name]
main = importlib.import_module("app.main")
client = TestClient(main.app)


def _login() -> dict:
    res = client.post("/auth/login", json={"email": "r@test.local", "password": "changeme"})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture(scope="module")
def auth() -> dict:
    return _login()


@pytest.fixture
def session(auth) -> dict:
    res = client.post(
        "/sessions",
        json={
            "candidateEmail": "cand@test.edu",
            "candidateName": "Test Candidate",
            "resumeText": "Built a document Q&A service used by 200 students.",
        },
        headers=auth,
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_config_never_carries_a_password():
    body = client.get("/config").json()
    assert body == {"demoMode": True}
    assert "password" not in str(body).lower()


def test_login_rejects_wrong_password():
    res = client.post("/auth/login", json={"email": "r@test.local", "password": "nope"})
    assert res.status_code == 401


def test_login_survives_non_ascii_password():
    res = client.post("/auth/login", json={"email": "r@test.local", "password": "pässwörd"})
    assert res.status_code == 401


def test_demo_login_mints_a_token():
    res = client.post("/auth/demo")
    assert res.status_code == 200
    assert res.json()["token"]


def test_sessions_require_auth():
    assert client.get("/sessions").status_code == 401


def test_invite_creates_a_row_and_reissues_a_link(auth, session):
    rows = client.get("/sessions", headers=auth).json()
    row = next(r for r in rows if r["id"] == session["sessionId"])
    assert row["candidate"] == "Test Candidate"
    assert row["started"] is False
    assert row["durationSeconds"] == 0
    assert row["overall"] is None
    assert row["skillsTotal"] == 4  # communication is cross-cutting

    res = client.get(f"/sessions/{session['sessionId']}/invite", headers=auth)
    assert res.status_code == 200
    assert res.json()["inviteToken"] != session["inviteToken"]


def test_invalid_rubric_is_a_400_not_a_500(auth):
    res = client.post(
        "/sessions",
        json={"candidateEmail": "x@test.edu", "rubric": "does_not_exist"},
        headers=auth,
    )
    assert res.status_code == 400
    res = client.post(
        "/sessions",
        json={"candidateEmail": "x@test.edu", "rubric": "../etc/passwd"},
        headers=auth,
    )
    assert res.status_code == 422


def test_roles_lists_both_rubrics(auth):
    roles = client.get("/roles", headers=auth).json()
    keys = {r["key"] for r in roles}
    assert {"backend_intern", "frontend_intern"} <= keys
    backend = next(r for r in roles if r["key"] == "backend_intern")
    assert any(s["cross_cutting"] for s in backend["skills"])


def test_evals_report_has_the_expected_shape(auth):
    body = client.get("/evals", headers=auth).json()
    assert set(body) == {"ranAt", "model", "provider", "runs", "summary"}
    assert set(body["summary"]) == {"total", "passed", "branchingProven"}


def test_candidate_intro_and_consent(session):
    token = session["inviteToken"]
    intro = client.get(f"/interview/{token}").json()
    assert intro["candidate"] == "Test Candidate"
    assert intro["consented"] is False

    res = client.post("/interview/consent", json={"token": token, "recordingConsent": False})
    assert res.status_code == 400
    res = client.post("/interview/consent", json={"token": token, "recordingConsent": True})
    assert res.status_code == 200
    assert client.get(f"/interview/{token}").json()["consented"] is True


def test_decision_persists_with_who_and_when(auth, session):
    sid = session["sessionId"]
    res = client.post(f"/sessions/{sid}/decision", json={"decision": "advance"}, headers=auth)
    assert res.status_code == 200
    card = client.get(f"/sessions/{sid}", headers=auth).json()
    assert card["decision"] == "advance"
    assert card["decidedBy"] == "r@test.local"
    assert card["decidedAt"]
    assert card["overall"] is None
    assert card["usage"] is None


def test_decision_rejects_unknown_values(auth, session):
    res = client.post(f"/sessions/{session['sessionId']}/decision", json={"decision": "hire"}, headers=auth)
    assert res.status_code == 422


def test_close_freezes_the_interview(auth, session):
    sid = session["sessionId"]
    res = client.post(f"/sessions/{sid}/close", headers=auth)
    assert res.status_code == 200
    card = client.get(f"/sessions/{sid}", headers=auth).json()
    assert card["finished"] is True
    assert card["stop_reason"] == "incomplete"


def test_delete_then_404(auth, session):
    sid = session["sessionId"]
    assert client.delete(f"/sessions/{sid}", headers=auth).status_code == 200
    assert client.get(f"/sessions/{sid}", headers=auth).status_code == 404
    assert client.delete(f"/sessions/{sid}", headers=auth).status_code == 404


def test_websocket_rejects_a_bad_token():
    with client.websocket_connect("/ws/interview/not-a-token") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "Rejected"


def _pdf(text: str) -> bytes:
    """Smallest valid PDF carrying one line of text."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF".encode()
    )
    return bytes(out)


def test_resume_upload_reads_a_pdf(auth):
    body = _pdf("Built a document Q and A service used by 200 students at placement season")
    res = client.post(
        "/resumes/parse",
        files={"file": ("aditya.pdf", body, "application/pdf")},
        headers=auth,
    )
    assert res.status_code == 200, res.text
    assert "document Q and A service" in res.json()["text"]


def test_resume_upload_rejects_unsupported_and_empty(auth):
    res = client.post(
        "/resumes/parse", files={"file": ("photo.png", b"\x89PNG\r\n", "image/png")}, headers=auth
    )
    assert res.status_code == 400
    assert "PDF" in res.json()["detail"]

    res = client.post(
        "/resumes/parse", files={"file": ("empty.txt", b"hi", "text/plain")}, headers=auth
    )
    assert res.status_code == 400
    assert "No text found" in res.json()["detail"]


def test_bulk_invite_reports_each_row(auth):
    res = client.post(
        "/sessions/bulk",
        json={
            "candidates": [
                {"candidateEmail": "one@test.edu", "candidateName": "One"},
                {"candidateEmail": "two@test.edu", "rubric": "frontend_intern"},
                {"candidateEmail": "three@test.edu", "rubric": "no_such_rubric"},
                {"candidateEmail": "four-at-test.edu"},
            ]
        },
        headers=auth,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # A bad row must not cost the good ones -- including a mistyped address,
    # which would otherwise fail validation and reject the whole request.
    assert len(body["created"]) == 2
    assert len(body["failed"]) == 2
    assert {f["candidateEmail"] for f in body["failed"]} == {"three@test.edu", "four-at-test.edu"}
    assert all(row["inviteToken"] for row in body["created"])


def test_compare_groups_candidates_by_role(auth):
    res = client.get("/compare", params={"rubric": "backend_intern"}, headers=auth)
    assert res.status_code == 200
    body = res.json()
    assert body["title"] == "Backend engineering intern"
    assert [s["key"] for s in body["skills"]]
    # Not-yet-started candidates are noise in a comparison.
    assert all(c["finished"] or c["durationSeconds"] >= 0 for c in body["candidates"])

    assert client.get("/compare", params={"rubric": "nope"}, headers=auth).status_code == 400


def test_warning_frames_are_stored_and_served(auth):
    """A warning with a photograph attached is the point of the feature."""
    from app import relay, store

    res = client.post(
        "/sessions", json={"candidateEmail": "shot@test.edu", "rubric": "backend_intern"}, headers=auth
    )
    session_id = res.json()["sessionId"]
    session = store.get(session_id)
    store.start(session)

    # Smallest thing that is really a JPEG: the magic bytes are checked, the
    # rest of the file is never parsed.
    jpeg = bytes.fromhex("ffd8ff") + b"not really an image, but shaped like one"
    store.add_integrity_flag(session, "looking_away", "Looked away for 5s", jpeg)
    store.add_integrity_flag(session, "paste", "Pasted 200 characters")

    card = client.get(f"/sessions/{session_id}", headers=auth).json()
    flagged, unflagged = card["integrity"]
    assert unflagged["shot"] is None
    assert flagged["shot"]

    got = client.get(f"/sessions/{session_id}/evidence/{flagged['shot']}", headers=auth)
    assert got.status_code == 200
    assert got.content == jpeg

    # An <img> cannot send a header, so the same token is allowed in the query.
    token = auth["Authorization"].split()[1]
    assert client.get(f"/sessions/{session_id}/evidence/{flagged['shot']}?token={token}").status_code == 200
    assert client.get(f"/sessions/{session_id}/evidence/{flagged['shot']}").status_code == 401

    # Nothing outside the session's own folder, whatever the URL asks for.
    assert store.evidence_path(session_id, "../../screenr.db") is None
    assert store.evidence_path(session_id, "nope.jpg") is None

    # Deleting the interview takes its frames with it.
    assert (store.EVIDENCE_DIR / session_id).exists()
    client.delete(f"/sessions/{session_id}", headers=auth)
    assert not (store.EVIDENCE_DIR / session_id).exists()

    # Anything that is not a small JPEG data URL is refused before it is stored.
    assert relay._decode_shot("data:image/png;base64,iVBORw0KGgo=") is None
    assert relay._decode_shot("not a data url") is None
    assert relay._decode_shot(None) is None
