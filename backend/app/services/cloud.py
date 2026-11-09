"""Ollama cloud (the ollama.com API): the same chat API as a local Ollama, authenticated with an API key.

Differences from the local client, all from Ollama's documentation:
  * `Authorization: Bearer <key>`; the key comes from Settings or OLLAMA_API_KEY and is never logged or put in an error message;
  * the cloud does not support structured outputs (`format`), so the JSON schema goes into the PROMPT and the reply is validated by us;
  * reasoning models bill their thinking tokens, so gpt-oss is asked for `think: "low"` and the output cap leaves room for the thinking;
  * a model's cloud name has no suffix in API calls ("gpt-oss:120b"; the CLI spelling "gpt-oss:120b-cloud" is accepted and normalised).
Nothing here runs unless the user switched to cloud mode and consented; there is no background polling.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Optional

import httpx

from ..config import Settings
from .ollama import LLMError, _error_text, consume_chat_stream
from .pricing import normalise

log = logging.getLogger("interviewer.cloud")

SCHEMA_NOTE = ("\n\nOUTPUT FORMAT: reply with ONE JSON object and nothing else (no markdown fences, no commentary). "
               "It must match this JSON Schema:\n{schema}")
MIN_OUTPUT_TOKENS = 1500          # headroom so a reasoning model's thinking cannot eat the whole answer


def api_name(model: str) -> str:
    """The name to send to the API: the CLI spelling 'x:cloud' / 'x-cloud' becomes 'x'."""
    return normalise(model) if normalise(model) != model.strip().lower() else model.strip()


def with_schema(messages: list[dict[str, str]], schema: dict[str, Any]) -> list[dict[str, str]]:
    """Cloud models ignore `format`, so tell the model the schema in words (Ollama's own recommendation)."""
    note = SCHEMA_NOTE.format(schema=json.dumps(schema, separators=(",", ":")))
    out = [dict(m) for m in messages]
    for m in out:
        if m.get("role") == "system":
            m["content"] = m["content"] + note
            return out
    return [{"role": "system", "content": note.strip()}] + out


class CloudClient:
    def __init__(self, settings: Settings, key: Callable[[], Optional[str]], http: Optional[httpx.Client] = None):
        self.settings = settings
        self._key = key
        self.http = http or httpx.Client(base_url=settings.cloud_url, timeout=httpx.Timeout(10.0, read=settings.cloud_idle_timeout_s))
        self.lock = threading.Lock()                       # one cloud request at a time (the free tier allows 3; we never need more)
        self.on_usage: Optional[Callable[[dict[str, Any]], None]] = None
        self._no_think: set[str] = set()

    # ------------------------------------------------------------ helpers
    def _headers(self) -> dict[str, str]:
        key = self._key()
        if not key:
            raise LLMError("auth_missing", "No Ollama cloud API key is saved. Add it in Settings → AI models, or switch back to the local model.")
        return {"Authorization": f"Bearer {key}"}

    def _redact(self, text: str) -> str:
        key = self._key()
        return text.replace(key, "[key]") if key else text

    def _raise_for(self, status: int, body: str, model: str) -> None:
        detail = self._redact(_error_text(body))[:300]
        if status in (401, 403):
            raise LLMError("auth_failed", f"Ollama cloud rejected the API key, or this account has no access to “{model}”. Check the key in Settings → AI models.")
        if status == 402:
            raise LLMError("no_credits", "Your Ollama cloud account has no credits left. Add credits at ollama.com, or switch to the local model in Settings → AI models.")
        if status == 404 or "not found" in detail.lower():
            raise LLMError("model_missing", f"Cloud model “{model}” was not found. Choose another in Settings → AI models (Test connection lists what is available).")
        if status == 429:
            raise LLMError("rate_limited", "Ollama cloud says there are too many requests right now. Wait a moment, then press Retry.")
        if status >= 500:
            raise LLMError("cloud_unavailable", f"Ollama cloud had a problem (HTTP {status}). Try again in a moment.")
        raise LLMError("failed", f"Ollama cloud returned HTTP {status}: {detail}")

    def _transport_error(self, e: Exception) -> LLMError:
        if isinstance(e, httpx.TimeoutException):
            return LLMError("timeout", "Ollama cloud did not answer in time.")
        if isinstance(e, httpx.ConnectError):
            return LLMError("cloud_unavailable", "Cannot reach Ollama cloud. Check your internet connection.")
        return LLMError("cloud_unavailable", f"The connection to Ollama cloud failed ({type(e).__name__}).")

    def _think(self, model: str):
        if model in self._no_think:
            return None
        return "low" if normalise(model).startswith("gpt-oss") else False

    def _payload(self, messages, schema, model, max_tokens, temperature, stream: bool = True) -> dict[str, Any]:
        cap = min(self.settings.cloud_max_tokens, max(max_tokens or 0, MIN_OUTPUT_TOKENS))
        payload: dict[str, Any] = {"model": api_name(model), "messages": with_schema(messages, schema) if schema else messages, "stream": stream,
                                   "options": {"temperature": self.settings.llm_temperature if temperature is None else temperature, "num_predict": cap}}
        think = self._think(model)
        if think is not None:
            payload["think"] = think
        return payload

    def _report(self, reply: dict[str, Any], model: str, purpose: str) -> None:
        if self.on_usage:
            try:
                from .usage import from_ollama

                self.on_usage(from_ollama(reply, model, purpose, provider="cloud"))
            except Exception:
                log.debug("could not report cloud usage", exc_info=True)

    # ------------------------------------------------------------ chat
    def chat_json(self, messages: list[dict[str, str]], schema: dict[str, Any], *, model: str, max_tokens: Optional[int] = None,
                  temperature: Optional[float] = None, purpose: str = "chat") -> str:
        headers = self._headers()
        with self.lock:
            deadline = time.monotonic() + self.settings.cloud_timeout_s
            for attempt in range(2):
                payload = self._payload(messages, schema, model, max_tokens, temperature)
                try:
                    with self.http.stream("POST", "/api/chat", json=payload, headers=headers) as r:
                        if r.status_code != 200:
                            body = r.read().decode("utf-8", "replace")
                            err = _error_text(body).lower()
                            if attempt == 0 and r.status_code == 400 and "think" in err:
                                self._no_think.add(model)            # this model has no thinking switch: ask again without it (a 400 costs nothing)
                                continue
                            self._raise_for(r.status_code, body, model)
                        text, final = consume_chat_stream(r, deadline)
                        self._report(final, model, purpose)
                        return text
                except LLMError:
                    raise
                except httpx.HTTPError as e:
                    raise self._transport_error(e) from e
        raise LLMError("failed", "Ollama cloud rejected the request.")

    # ------------------------------------------------------------ connection test (no inference unless asked)
    def list_models(self) -> list[str]:
        """GET /api/tags: which cloud models this key can use. Not a model call."""
        headers = self._headers()
        try:
            r = self.http.get("/api/tags", headers=headers, timeout=20)
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e
        if r.status_code != 200:
            self._raise_for(r.status_code, r.text, "the model list")
        try:
            return sorted({str(m.get("name") or m.get("model")) for m in r.json().get("models", []) if m.get("name") or m.get("model")})
        except (ValueError, AttributeError) as e:
            raise LLMError("bad_response", "Ollama cloud sent a model list we could not read.") from e

    def tiny_message(self, model: str) -> dict[str, Any]:
        """One very small real request (about 30 tokens, a fraction of a cent) to prove a model answers. Only on explicit request."""
        headers = self._headers()
        payload = {"model": api_name(model), "messages": [{"role": "user", "content": "Reply with the single word: ok"}], "stream": False,
                   "options": {"temperature": 0, "num_predict": 64}}
        think = self._think(model)
        if think is not None:
            payload["think"] = think
        with self.lock:
            for attempt in range(2):
                try:
                    r = self.http.post("/api/chat", json=payload, headers=headers, timeout=60)
                except httpx.HTTPError as e:
                    raise self._transport_error(e) from e
                if r.status_code == 400 and "think" in r.text.lower() and attempt == 0:
                    payload.pop("think", None)
                    continue
                if r.status_code != 200:
                    self._raise_for(r.status_code, r.text, model)
                break
        try:
            reply = r.json()
        except ValueError as e:
            raise LLMError("bad_response", "Ollama cloud sent a reply we could not read.") from e
        self._report(reply, model, "test")
        return {"text": ((reply.get("message") or {}).get("content") or "").strip()[:80], "prompt_tokens": reply.get("prompt_eval_count"), "output_tokens": reply.get("eval_count")}
