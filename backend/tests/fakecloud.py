"""A stand-in for Ollama cloud's documented API (POST /api/chat streaming, GET /api/tags). No network, no credits.

It records every request so tests can prove WHAT was sent (key, model, no `format`, schema in the prompt) and HOW MANY calls were made.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

import httpx

from app.config import Settings
from app.services.cloud import CloudClient

KEY = "test-key-1234567890abcd"
ALL_MODELS = ["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b", "kimi-k3", "glm-5.3"]


class FakeCloud:
    def __init__(self):
        self.models = list(ALL_MODELS)
        self.requests: list[dict[str, Any]] = []          # every request: method, path, headers, json
        self.replies: list[Any] = []                      # queue: dict -> JSON answer, str -> raw text, int -> HTTP error code, Exception -> raise
        self.default: Optional[Callable[[dict], Any]] = smart_default
        self.prompt_tokens, self.output_tokens = 900, 450
        self.status_for_tags = 200

    # ------------------------------------------------------------ introspection
    @property
    def chats(self) -> list[dict]:
        return [r for r in self.requests if r["path"] == "/api/chat"]

    @property
    def tags_calls(self) -> list[dict]:
        return [r for r in self.requests if r["path"] == "/api/tags"]

    def models_used(self) -> list[str]:
        return [r["json"]["model"] for r in self.chats]

    # ------------------------------------------------------------ the HTTP handler
    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append({"method": request.method, "path": request.url.path, "headers": dict(request.headers), "json": body, "host": request.url.host})
        if request.url.path == "/api/tags":
            if self.status_for_tags != 200:
                return httpx.Response(self.status_for_tags, json={"error": "nope"})
            return httpx.Response(200, json={"models": [{"name": m, "model": m} for m in self.models]})
        if request.url.path == "/api/chat":
            reply = self.replies.pop(0) if self.replies else (self.default(body) if self.default else {"ok": True})
            if isinstance(reply, int):
                return httpx.Response(reply, json={"error": f"error {reply}"})
            if isinstance(reply, Exception):
                raise reply
            text = reply if isinstance(reply, str) else json.dumps(reply)
            metrics = {"prompt_eval_count": self.prompt_tokens, "eval_count": self.output_tokens, "load_duration": 0,
                       "prompt_eval_duration": 300_000_000, "eval_duration": 9_000_000_000, "total_duration": 9_400_000_000}
            if body.get("stream") is False:
                return httpx.Response(200, json={"message": {"role": "assistant", "content": text}, "done": True, **metrics})
            lines = [json.dumps({"message": {"role": "assistant", "thinking": "(reasoning)", "content": ""}, "done": False}),
                     json.dumps({"message": {"role": "assistant", "content": text[:25]}, "done": False}),
                     json.dumps({"message": {"role": "assistant", "content": text[25:]}, "done": True, **metrics})]
            return httpx.Response(200, content=("\n".join(lines) + "\n").encode())
        return httpx.Response(404, json={"error": "unknown"})


def smart_default(body: dict) -> Any:
    """Answer each kind of request the app makes, recognised by its system prompt."""
    from conftest import good_eval

    system = body["messages"][0]["content"]
    if "evaluating ONE candidate answer" in system:
        return good_eval(correctness=8)
    if "repair speech-recognition transcripts" in system:
        return {"text": "MySQL is a relational database.", "unclear": []}
    if "Write ONE short follow-up question" in system:
        return {"question": "Which key would you merge on, and why that one?"}
    if "closing assessment" in system:
        return {"overall_summary": "A solid session.", "strengths": ["Clear"], "knowledge_gaps": [], "repeated_misconceptions": [], "topics_to_revise": [], "recommendations": ["Keep going"]}
    return {"ok": True}


def make_cloud(settings: Settings, fake: FakeCloud, key: Optional[str] = KEY, key_provider: Optional[Callable[[], Optional[str]]] = None) -> CloudClient:
    """`key` is a fixed test key; `key_provider` reads it from somewhere live (the real app reads it from its settings or OLLAMA_API_KEY)."""
    http = httpx.Client(base_url=settings.cloud_url, transport=httpx.MockTransport(fake.handler), timeout=5)
    return CloudClient(settings, key=key_provider or (lambda: key), http=http)
