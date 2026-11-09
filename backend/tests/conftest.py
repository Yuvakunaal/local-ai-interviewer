from __future__ import annotations

import json
import struct
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.deps import build_container
from app.main import create_app
from app.services.ollama import OllamaClient

VOICES = ["default", "Harper", "Hugh"]


def good_eval(*, correctness=8, followup: Optional[str] = None, reason="Covered the essentials.", missing=None,
              misconceptions=None, production=False) -> dict[str, Any]:
    return {
        "correct_points": ["Explained the core idea"], "missing_concepts": missing or [],
        "misconceptions": misconceptions or [],
        "dimension_scores": {"correctness": correctness, "completeness": correctness, "depth": correctness,
                             "practical_application": correctness, "clarity": correctness,
                             "production_awareness": correctness},
        "production_relevant": production, "verdict_summary": "A short overall judgement.", "suggested_improvements": ["Add an example"],
        "ideal_answer": "A concise reference answer.", "confidence": "high", "uncertainty_note": "",
        "needs_followup": followup is not None, "followup_question": followup or "", "followup_reason": reason,
    }


class InlineExecutor:
    """Runs submitted work immediately so tests are deterministic."""

    def submit(self, fn: Callable, *a, **kw) -> Future:
        f: Future = Future()
        try:
            f.set_result(fn(*a, **kw))
        except BaseException as e:  # pragma: no cover
            f.set_exception(e)
        return f


class FakeOllama:
    """Scriptable stand-in for the Ollama HTTP API; also records every request."""

    def __init__(self):
        self.models = ["qwen3.5:4b", "phonon:latest"]
        self.up = True
        self.chat_replies: list[Any] = []   # dict -> JSON reply, str -> raw text, Exception -> raise
        self.chat_calls: list[dict] = []
        self.tts_calls: list[dict] = []
        self.tts_silent = False
        self.hosts: set[str] = set()
        self.chat_error: Optional[tuple[int, str]] = None
        self.loaded: list[str] = []               # models "in memory" according to /api/ps
        self.generate_calls: list[dict] = []      # load / unload requests
        self.generate_fails = False               # make load / unload requests fail
        self.load_ns = 0                          # model load time (ns) reported with each reply
        self.pull_calls: list[dict] = []          # /api/pull requests
        self.pull_fail: Optional[str] = None      # make the next pull report this error

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.hosts.add(request.url.host)
        if not self.up:
            raise httpx.ConnectError("refused", request=request)
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.40.12"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m, "model": m} for m in self.models]})
        if path == "/api/pull":
            self.pull_calls.append(body)
            if self.pull_fail:
                return httpx.Response(200, content=(json.dumps({"error": self.pull_fail}) + "\n").encode())
            lines = [json.dumps({"status": "pulling manifest"}), json.dumps({"status": "pulling abc123", "total": 1000, "completed": 250}),
                     json.dumps({"status": "pulling abc123", "total": 1000, "completed": 1000}), json.dumps({"status": "success"})]
            if body["model"] not in self.models:
                self.models.append(body["model"])
            return httpx.Response(200, content=("\n".join(lines) + "\n").encode())
        if path == "/api/ps":
            return httpx.Response(200, json={"models": [{"name": n} for n in self.loaded]})
        if path == "/api/generate":                       # load (keep_alive > 0) / unload (keep_alive == 0) a model
            if self.generate_fails:
                raise httpx.ConnectError("generate refused", request=request)
            self.generate_calls.append(body)
            if body.get("keep_alive") == 0:
                self.loaded = [n for n in self.loaded if n != body["model"]]
            elif body["model"] not in self.loaded:
                self.loaded.append(body["model"])
            return httpx.Response(200, json={"done": True, "load_duration": self.load_ns, "total_duration": self.load_ns})
        if path == "/api/show":
            if body["model"] not in self.models and f"{body['model']}:latest" not in self.models:
                return httpx.Response(404, json={"error": "model not found"})
            if body["model"].startswith("phonon"):
                return httpx.Response(200, json={"capabilities": ["speech"], "voices": VOICES})
            return httpx.Response(200, json={"capabilities": ["completion"]})
        if path == "/api/chat":
            self.chat_calls.append(body)
            if self.chat_error:
                code, msg = self.chat_error
                return httpx.Response(code, json={"error": msg})
            reply = self.chat_replies.pop(0) if self.chat_replies else good_eval()
            if callable(reply):                       # a function of the request: answers depending on the prompt
                reply = reply(body)
            if isinstance(reply, Exception):
                raise reply
            text = reply if isinstance(reply, str) else json.dumps(reply)
            lines = [json.dumps({"message": {"content": text[:20]}, "done": False}),
                     json.dumps({"message": {"content": text[20:]}, "done": True, "prompt_eval_count": 800, "eval_count": 400,
                                 "load_duration": self.load_ns, "prompt_eval_duration": 200_000_000, "eval_duration": 20_000_000_000,
                                 "total_duration": 20_300_000_000 + self.load_ns})]
            return httpx.Response(200, content=("\n".join(lines) + "\n").encode())
        if path == "/v1/audio/speech":
            self.tts_calls.append(body)
            if body["voice"] not in VOICES:
                return httpx.Response(400, json={"error": {"message": f'voice "{body["voice"]}" not found'}})
            n = 0 if self.tts_silent else 24000  # 0.5 s of 16-bit samples
            pcm = b"".join(struct.pack("<h", 3000 if i % 2 else -3000) for i in range(n))
            return httpx.Response(200, content=pcm, headers={"content-type": "audio/pcm"})
        return httpx.Response(404, json={"error": "unknown"})


@pytest.fixture
def fake() -> FakeOllama:
    return FakeOllama()


def make_settings(tmp_path: Path, **kw) -> Settings:
    return Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "nodist", **kw)


@pytest.fixture
def settings(tmp_path) -> Settings:
    return make_settings(tmp_path)


def make_client_for(settings: Settings, fake: FakeOllama) -> OllamaClient:
    http = httpx.Client(base_url=settings.ollama_host, transport=httpx.MockTransport(fake.handler))
    return OllamaClient(settings, http=http)


@pytest.fixture
def container(settings, fake):
    return build_container(settings, ollama=make_client_for(settings, fake), executor=InlineExecutor())


@pytest.fixture
def client(settings, container) -> TestClient:
    app = create_app(settings, container)
    return TestClient(app, base_url="http://127.0.0.1:3000")


@pytest.fixture
def set_id(client) -> int:
    return client.get("/api/sets").json()[0]["id"]


def add_questions(client, set_id: int, n: int = 3, **extra) -> list[dict]:
    out = []
    for i in range(n):
        r = client.post(f"/api/sets/{set_id}/questions",
                        json={"text": f"Question number {i + 1}?", "topic": ["SQL", "Spark", "SQL"][i % 3], **extra})
        assert r.status_code == 201, r.text
        out.append(r.json())
    return out


def end_active(client) -> None:
    """Only one interview can be active at a time; tests that need a second one end the first."""
    for row in client.get("/api/interviews").json():
        if row["status"] in ("in_progress", "paused"):
            assert client.post(f"/api/interviews/{row['id']}/end").status_code == 200


def start_interview(client, set_id: int, *, replace: bool = False, **cfg) -> dict:
    if replace:
        end_active(client)
    config = {"title": "T", "max_followups": 2, "voice": "Harper", **cfg}
    r = client.post("/api/interviews", json={"set_id": set_id, "config": config})
    assert r.status_code == 201, r.text
    return r.json()


def answer(client, st: dict, text: str = "My answer", **kw):
    return client.post(f"/api/interviews/{st['id']}/answer", json={"turn_id": st["current_turn_id"], "text": text, **kw})


def act(client, st: dict, action: str):
    return client.post(f"/api/interviews/{st['id']}/{action}", json={"turn_id": st["current_turn_id"]})


def state(client, iid: int) -> dict:
    return client.get(f"/api/interviews/{iid}").json()


# ---------------------------------------------------------------- cloud mode (mock of Ollama cloud: no network, no credits)
from fakecloud import KEY as CLOUD_KEY, FakeCloud, make_cloud  # noqa: E402


@pytest.fixture
def cloud_fake() -> FakeCloud:
    return FakeCloud()


@pytest.fixture
def cloud_client(tmp_path, fake, cloud_fake):
    """A test client whose app has a mocked cloud attached. Still in LOCAL mode until a test switches it on."""
    s = make_settings(tmp_path)
    holder: dict = {}
    cloud = make_cloud(s, cloud_fake, key_provider=lambda: holder["ai"].api_key())     # the key comes from the app's own store / OLLAMA_API_KEY, as in production
    c = build_container(s, ollama=make_client_for(s, fake), executor=InlineExecutor(), cloud=cloud)
    holder["ai"] = c.ai
    return TestClient(create_app(s, c), base_url="http://127.0.0.1:3000")


def enable_cloud(client: TestClient, **extra) -> dict:
    """Do what a user does in Settings: save the key, agree to the privacy notice, switch to cloud."""
    assert client.put("/api/ai/key", json={"api_key": CLOUD_KEY}).status_code == 200
    r = client.put("/api/ai", json={"mode": "cloud", "acknowledge_cloud": True, **extra})
    assert r.status_code == 200, r.text
    return r.json()
