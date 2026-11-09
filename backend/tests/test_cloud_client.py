"""The Ollama cloud client against a mock of the documented API: what it sends, how it reads replies, how it reports problems."""
import json

import httpx
import pytest

from app.services.cloud import CloudClient, api_name, with_schema
from app.services.ollama import LLMError
from conftest import make_settings
from fakecloud import KEY, FakeCloud, make_cloud

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
MSGS = [{"role": "system", "content": "You are a grader."}, {"role": "user", "content": "grade this"}]


@pytest.fixture
def pair(tmp_path):
    fake = FakeCloud()
    return fake, make_cloud(make_settings(tmp_path), fake)


def chat(client, model="gpt-oss:120b", **kw):
    return client.chat_json(MSGS, SCHEMA, model=model, **kw)


# ---------------------------------------------------------------- what is sent
def test_request_goes_to_the_cloud_chat_endpoint_with_a_bearer_key(pair):
    fake, client = pair
    chat(client)
    req = fake.chats[0]
    assert req["method"] == "POST" and req["host"] == "ollama.com" and req["path"] == "/api/chat"
    assert req["headers"]["authorization"] == f"Bearer {KEY}"
    assert len(fake.chats) == 1 and fake.tags_calls == []                       # exactly one request, no hidden extras


def test_structured_outputs_are_not_requested_because_the_cloud_does_not_support_them(pair):
    fake, client = pair
    chat(client)
    body = fake.chats[0]["json"]
    assert "format" not in body                                                  # Ollama's docs: cloud has no structured outputs
    system = body["messages"][0]["content"]
    assert system.startswith("You are a grader.") and "OUTPUT FORMAT" in system and '"required":["ok"]' in system   # the schema goes in the prompt
    assert body["messages"][1] == MSGS[1] and body["stream"] is True


def test_the_schema_is_added_even_when_there_is_no_system_message():
    out = with_schema([{"role": "user", "content": "hi"}], SCHEMA)
    assert out[0]["role"] == "system" and "OUTPUT FORMAT" in out[0]["content"] and out[1]["content"] == "hi"


@pytest.mark.parametrize("given, sent", [("gpt-oss:120b", "gpt-oss:120b"), ("gemma4:31b-cloud", "gemma4:31b"), ("gemma4:31b:cloud", "gemma4:31b"), ("deepseek-v4.1-flash", "deepseek-v4.1-flash")])
def test_the_api_name_has_no_cloud_suffix(pair, given, sent):
    fake, client = pair
    chat(client, model=given)
    assert fake.chats[0]["json"]["model"] == sent == api_name(given)


def test_reasoning_is_kept_low_for_gpt_oss_and_off_for_other_models(pair):
    fake, client = pair
    chat(client, model="gpt-oss:120b")
    chat(client, model="gemma4:31b")
    assert fake.chats[0]["json"]["think"] == "low" and fake.chats[1]["json"]["think"] is False


def test_the_output_cap_leaves_room_for_reasoning_but_is_bounded(pair):
    fake, client = pair
    chat(client)                                                                  # no caller cap
    chat(client, max_tokens=300)                                                  # small caller cap (e.g. a follow-up question)
    chat(client, max_tokens=50_000)                                               # absurd caller cap
    caps = [r["json"]["options"]["num_predict"] for r in fake.chats]
    assert caps == [1500, 1500, 3000]


def test_a_model_without_a_thinking_switch_is_retried_once_without_it_and_remembered(pair):
    fake, client = pair
    fake.replies = [400]                                                          # first request: HTTP 400
    fake.requests.clear()
    orig = fake.handler

    def handler(request):                                                          # make the 400 carry the telltale message
        resp = orig(request)
        if resp.status_code == 400:
            return httpx.Response(400, json={"error": "\"gemma4:31b\" does not support thinking"})
        return resp
    client.http = httpx.Client(base_url="https://ollama.com", transport=httpx.MockTransport(handler))
    chat(client, model="gemma4:31b")
    assert [("think" in r["json"]) for r in fake.chats] == [True, False]         # one retry, without `think`
    chat(client, model="gemma4:31b")
    assert "think" not in fake.chats[-1]["json"] and len(fake.chats) == 3         # remembered: no more wasted attempts


# ---------------------------------------------------------------- what comes back
def test_the_answer_is_returned_and_the_thinking_text_is_ignored(pair):
    fake, client = pair
    fake.replies = [{"ok": True, "n": 1}]
    assert json.loads(chat(client)) == {"ok": True, "n": 1}


def test_tokens_and_timings_are_reported_as_a_cloud_call(pair):
    fake, client = pair
    seen = []
    client.on_usage = seen.append
    chat(client, purpose="evaluation")
    assert seen == [{"model": "gpt-oss:120b", "purpose": "evaluation", "provider": "cloud", "prompt_tokens": 900, "output_tokens": 450,
                     "load_ms": 0, "prompt_ms": 300, "output_ms": 9000, "total_ms": 9400}]


def test_an_empty_reply_is_an_error_not_a_silent_success(pair):
    fake, client = pair
    fake.replies = [""]
    with pytest.raises(LLMError) as e:
        chat(client)
    assert e.value.code == "bad_response"


# ---------------------------------------------------------------- problems become plain, actionable messages
@pytest.mark.parametrize("status, code, words", [
    (401, "auth_failed", "rejected the API key"), (403, "auth_failed", "no access"), (402, "no_credits", "no credits"),
    (404, "model_missing", "was not found"), (429, "rate_limited", "too many requests"), (500, "cloud_unavailable", "HTTP 500"), (503, "cloud_unavailable", "HTTP 503"),
    (418, "failed", "HTTP 418"),
])
def test_http_errors_are_mapped_to_clear_messages(pair, status, code, words):
    fake, client = pair
    fake.replies = [status]
    with pytest.raises(LLMError) as e:
        chat(client)
    assert e.value.code == code and words in e.value.message
    assert KEY not in e.value.message and len(fake.chats) == 1                   # and a failure is never retried behind the user's back


def test_network_problems_are_reported_not_raised_raw(pair):
    fake, client = pair
    for exc, code in ((httpx.ConnectError("refused"), "cloud_unavailable"), (httpx.ReadTimeout("slow"), "timeout"), (httpx.RemoteProtocolError("bad"), "cloud_unavailable")):
        fake.replies = [exc]
        with pytest.raises(LLMError) as e:
            chat(client)
        assert e.value.code == code and KEY not in e.value.message


def test_an_echoed_key_is_redacted_from_server_messages(tmp_path):
    fake = FakeCloud()
    client = make_cloud(make_settings(tmp_path), fake)
    client.http = httpx.Client(base_url="https://ollama.com", transport=httpx.MockTransport(lambda r: httpx.Response(418, json={"error": f"bad token {KEY} sent"})))
    with pytest.raises(LLMError) as e:
        chat(client)
    assert KEY not in e.value.message and "[key]" in e.value.message


def test_no_key_means_no_request_at_all(tmp_path):
    fake = FakeCloud()
    client = make_cloud(make_settings(tmp_path), fake, key=None)
    for call in (lambda: chat(client), client.list_models, lambda: client.tiny_message("gpt-oss:120b")):
        with pytest.raises(LLMError) as e:
            call()
        assert e.value.code == "auth_missing"
    assert fake.requests == []


def test_a_server_error_inside_the_stream_is_reported(pair):
    fake, client = pair
    fake.replies = ['{"error": "model \'x\' not found"}']
    client.http = httpx.Client(base_url="https://ollama.com", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, content=b'{"error": "model not found"}\n')))
    with pytest.raises(LLMError) as e:
        chat(client)
    assert e.value.code == "model_missing"


# ---------------------------------------------------------------- connection test helpers
def test_listing_models_is_one_free_request_and_returns_sorted_names(pair):
    fake, client = pair
    assert client.list_models() == sorted(fake.models)
    assert len(fake.requests) == 1 and fake.requests[0]["path"] == "/api/tags" and fake.chats == []


def test_listing_models_maps_a_bad_key(pair):
    fake, client = pair
    fake.status_for_tags = 401
    with pytest.raises(LLMError) as e:
        client.list_models()
    assert e.value.code == "auth_failed"


def test_the_tiny_test_message_is_small_and_not_streamed(pair):
    fake, client = pair
    fake.replies = ["ok"]
    seen = []
    client.on_usage = seen.append
    out = client.tiny_message("gpt-oss:120b")
    body = fake.chats[0]["json"]
    assert body["stream"] is False and body["options"]["num_predict"] <= 64 and "format" not in body and len(fake.chats) == 1
    assert out["text"] == "ok" and seen[0]["purpose"] == "test" and seen[0]["provider"] == "cloud"
