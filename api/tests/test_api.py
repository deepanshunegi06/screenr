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
