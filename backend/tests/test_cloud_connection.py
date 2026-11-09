"""Settings -> AI models -> Test connection: free by default, rate limited, and honest about missing models."""
import logging

import pytest

from conftest import CLOUD_KEY, act, add_questions, answer, enable_cloud, start_interview, state
from fakecloud import ALL_MODELS


def with_key(client):
    assert client.put("/api/ai/key", json={"api_key": CLOUD_KEY}).status_code == 200


def reset_cooldown(client):
    client.app.state.ai_test_at = 0.0


def test_testing_lists_models_and_spends_no_tokens(cloud_client, cloud_fake):
    with_key(cloud_client)
    r = cloud_client.post("/api/ai/test", json={})
    d = r.json()
    assert r.status_code == 200 and d["ok"] is True and d["key_ok"] is True and d["models"] == sorted(ALL_MODELS) and d["missing"] == {}
    assert len(cloud_fake.tags_calls) == 1 and cloud_fake.chats == []                  # one free listing, no model call
    assert d["message_test"] is None and "All three models are available" in d["message"]


def test_a_second_click_within_seconds_is_refused_without_calling_the_cloud(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_client.post("/api/ai/test", json={})
    r = cloud_client.post("/api/ai/test", json={})
    assert r.status_code == 429 and r.json()["error"]["code"] == "too_soon"
    assert len(cloud_fake.requests) == 1                                                  # only the first click reached the cloud
    reset_cooldown(cloud_client)
    assert cloud_client.post("/api/ai/test", json={}).status_code == 200 and len(cloud_fake.requests) == 2


def test_missing_models_are_named_with_suggestions(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_fake.models = ["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:e4b", "gemma4:12b"]
    d = cloud_client.post("/api/ai/test", json={}).json()
    assert d["ok"] is False and d["key_ok"] is True and d["missing"] == {"conversation": "gemma4:31b"}
    assert set(d["suggestions"]["gemma4:31b"]) <= {"gemma4:e4b", "gemma4:12b"} and d["suggestions"]["gemma4:31b"]
    assert "not found" in d["message"]


def test_the_cli_spelling_of_a_model_name_counts_as_found(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_client.put("/api/ai", json={"conversation_model": "gemma4:31b-cloud"})
    assert cloud_client.post("/api/ai/test", json={}).json()["missing"] == {}


def test_a_rejected_key_is_reported_clearly(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_fake.status_for_tags = 401
    d = cloud_client.post("/api/ai/test", json={}).json()
    assert d["ok"] is False and d["key_ok"] is False and d["code"] == "auth_failed" and "rejected the API key" in d["message"] and CLOUD_KEY not in str(d)


def test_the_last_result_is_remembered_so_nothing_is_called_to_show_it(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_client.post("/api/ai/test", json={})
    n = len(cloud_fake.requests)
    again = cloud_client.get("/api/ai").json()
    assert again["last_test"]["ok"] is True and again["last_test"]["models"] == sorted(ALL_MODELS) and len(cloud_fake.requests) == n
    assert cloud_client.get("/api/health").json()["ai"]["last_test_ok"] is True


def test_a_real_test_message_is_only_sent_when_asked_and_is_tiny_and_tracked(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_fake.replies = ["ok"]
    d = cloud_client.post("/api/ai/test", json={"send_message": True}).json()
    assert d["message_test"]["ok"] is True and d["message_test"]["model"] == "gpt-oss:120b" and d["message_test"]["text"] == "ok"
    assert len(cloud_fake.chats) == 1 and cloud_fake.chats[0]["json"]["options"]["num_predict"] <= 64
    rec = cloud_client.app.state.c.usage.recent()[0]
    assert rec["purpose"] == "test" and rec["provider"] == "cloud" and rec["cost_usd"] == 0.000405      # it shows up in Model usage, with its cost


def test_a_failing_test_message_is_reported_without_hiding_the_connection_result(cloud_client, cloud_fake):
    with_key(cloud_client)
    cloud_fake.replies = [402]
    d = cloud_client.post("/api/ai/test", json={"send_message": True}).json()
    assert d["ok"] is True and d["message_test"]["ok"] is False and d["message_test"]["code"] == "no_credits"


def test_testing_needs_a_key_and_then_makes_no_request(cloud_client, cloud_fake):
    r = cloud_client.post("/api/ai/test", json={})
    assert r.status_code == 422 and r.json()["error"]["code"] == "key_required" and cloud_fake.requests == []


def test_testing_works_before_switching_to_cloud_so_nothing_is_committed_blindly(cloud_client, cloud_fake):
    with_key(cloud_client)
    assert cloud_client.post("/api/ai/test", json={}).status_code == 200
    assert cloud_client.get("/api/ai").json()["mode"] == "local"


# ---------------------------------------------------------------- privacy: the key and the user's text
def test_the_api_key_never_appears_in_any_response_log_or_export(cloud_client, cloud_fake, caplog):
    caplog.set_level(logging.DEBUG)
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 1)
    enable_cloud(cloud_client)
    st = start_interview(cloud_client, sid, max_followups=0)
    cloud_fake.replies = [401]
    st = answer(cloud_client, st).json()                                                  # a failing call, the riskiest moment for leaks
    cloud_fake.replies = [418]
    cloud_client.post(f"/api/interviews/{st['id']}/retry", json={"turn_id": state(cloud_client, st["id"])["current_turn_id"]})
    reset_cooldown(cloud_client)
    cloud_client.post("/api/ai/test", json={})
    st = state(cloud_client, st["id"])
    cloud_client.post(f"/api/interviews/{st['id']}/retry", json={"turn_id": st["current_turn_id"]})
    st = act(cloud_client, state(cloud_client, st["id"]), "continue").json()
    paths = ["/api/ai", "/api/health", "/api/usage", "/api/stats", "/api/sets", "/api/interviews", f"/api/interviews/{st['id']}",
             f"/api/interviews/{st['id']}/report", f"/api/interviews/{st['id']}/report/export?format=json", f"/api/interviews/{st['id']}/report/export?format=md",
             f"/api/sets/{sid}/export"]
    for path in paths:
        r = cloud_client.get(path)
        assert CLOUD_KEY not in r.text, path
    assert CLOUD_KEY not in caplog.text


def test_a_key_from_the_environment_never_leaks_either(cloud_client, cloud_fake, monkeypatch, caplog):
    monkeypatch.setenv("OLLAMA_API_KEY", "env-secret-key-9876543210")
    caplog.set_level(logging.DEBUG)
    cloud_client.put("/api/ai", json={"mode": "cloud", "acknowledge_cloud": True})
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 1)
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)
    assert cloud_fake.chats[0]["headers"]["authorization"] == "Bearer env-secret-key-9876543210"
    for path in ("/api/ai", "/api/health", "/api/usage"):
        assert "env-secret-key-9876543210" not in cloud_client.get(path).text
    assert "env-secret-key-9876543210" not in caplog.text


def test_in_cloud_mode_only_the_interview_text_goes_to_the_cloud_and_voice_stays_local(cloud_client, cloud_fake, fake):
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 1)
    enable_cloud(cloud_client)
    n = len(cloud_fake.requests)
    cloud_client.post("/api/speech/synthesize", json={"text": "Spoken question text", "voice": "Harper"})    # Phonon: local Ollama
    assert len(cloud_fake.requests) == n and fake.tts_calls                                                    # the cloud saw nothing
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st, "UNIQUE-ANSWER-TEXT")
    assert {r["host"] for r in cloud_fake.requests} == {"ollama.com"}
    sent = json_dump(cloud_fake.chats[0]["json"])
    assert "UNIQUE-ANSWER-TEXT" in sent and "Question number 1?" in sent                                        # the interview text, as disclosed
    for secret in (CLOUD_KEY, str(cloud_client.app.state.c.settings.data_dir), "interviewer.sqlite3"):
        assert secret not in sent


def json_dump(obj) -> str:
    import json

    return json.dumps(obj)


def test_nothing_is_sent_to_the_cloud_when_consent_was_never_given(cloud_client, cloud_fake):
    sid = cloud_client.get("/api/sets").json()[0]["id"]
    add_questions(cloud_client, sid, 1)
    cloud_client.put("/api/ai/key", json={"api_key": CLOUD_KEY})
    assert cloud_client.put("/api/ai", json={"mode": "cloud"}).status_code == 422
    st = start_interview(cloud_client, sid, max_followups=0)
    answer(cloud_client, st)
    assert cloud_fake.requests == []
