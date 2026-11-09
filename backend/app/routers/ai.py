"""Settings -> AI models: choose local or cloud, add the API key, pick models, set a budget, test the connection.

Credit safety: nothing here calls the cloud except POST /api/ai/test (which only LISTS models unless the user asks for one tiny message),
and that endpoint refuses to run more than once every few seconds. GET endpoints never touch the network.
"""
from __future__ import annotations

import difflib
import time
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..db import utcnow
from ..errors import AppError
from ..services.ai_config import AIConfigUpdate
from ..services.ollama import LLMError
from ..services.pricing import normalise

router = APIRouter(prefix="/api/ai", tags=["ai"])
TEST_COOLDOWN_S = 5.0


class KeyIn(BaseModel):
    api_key: str


class TestIn(BaseModel):
    send_message: bool = False          # also send one tiny real request (about 30 tokens) to the grader model


def public(c) -> dict[str, Any]:
    """Everything the Settings page needs. The API key itself is never included, only whether one exists."""
    cfg = c.ai.get()
    key = c.ai.key_info()
    return {
        "mode": cfg.mode,
        "ready": cfg.mode == "local" or (key["set"] and bool(cfg.cloud_consent_at)),
        "config": cfg.model_dump(),
        "key": key,
        "budget": c.gateway.budget_status(cfg),
        "last_test": c.ai.last_test(),
        "local_model": c.settings.llm_model,
        "roles": {"grader": "Grades answers, writes the feedback and the report summary.", "fallback": "Takes over automatically if the grader fails; also a good alternative grader.",
                  "conversation": "Writes follow-up questions and cleans up voice transcripts."},
        "sent_to_cloud": ["Your interview questions", "Your answers (typed, or the text of what you said)", "Your expected answers / rubrics"],
        "stays_local": ["Your voice recordings and the speech-to-text", "The spoken questions (voice)", "Your database, reports and settings"],
    }


@router.get("")
def get_ai(request: Request) -> dict[str, Any]:
    return public(request.app.state.c)


@router.put("")
def put_ai(body: AIConfigUpdate, request: Request) -> dict[str, Any]:
    c = request.app.state.c
    c.ai.update(body)
    return public(c)


@router.put("/key")
def put_key(body: KeyIn, request: Request) -> dict[str, Any]:
    c = request.app.state.c
    c.ai.set_key(body.api_key)
    return public(c)


@router.delete("/key")
def delete_key(request: Request) -> dict[str, Any]:
    c = request.app.state.c
    c.ai.clear_key()
    return public(c)


@router.post("/test")
def test_connection(body: TestIn, request: Request) -> dict[str, Any]:
    """Check the key and list the models it can use. Not a model call (no tokens, no cost) unless `send_message` is true."""
    c = request.app.state.c
    now = time.monotonic()
    last = getattr(request.app.state, "ai_test_at", 0.0)
    if now - last < TEST_COOLDOWN_S:
        raise AppError(429, "too_soon", f"Please wait a few seconds between connection tests ({TEST_COOLDOWN_S:.0f} s). This protects your credits.")
    request.app.state.ai_test_at = now
    if not c.ai.api_key():
        raise AppError(422, "key_required", "Add your Ollama cloud API key first.")
    result: dict[str, Any] = {"at": utcnow(), "ok": False, "key_ok": False, "models": [], "missing": {}, "suggestions": {}, "message_test": None}
    try:
        models = c.cloud.list_models()
    except LLMError as e:
        result.update(code=e.code, message=e.message)
        c.ai.save_test(result)
        return result
    cfg = c.ai.get()
    wanted = {"grader": cfg.grader_model, "fallback": cfg.fallback_model, "conversation": cfg.conversation_model}
    have = {normalise(m) for m in models}
    missing = {role: m for role, m in wanted.items() if normalise(m) not in have}
    result.update(key_ok=True, models=models, missing=missing, ok=not missing,
                  suggestions={m: difflib.get_close_matches(normalise(m), [normalise(x) for x in models], n=3, cutoff=0.45) for m in missing.values()},
                  message=("Connected. All three models are available." if not missing else "Connected, but some models you chose were not found."))
    if body.send_message:
        try:
            result["message_test"] = {"ok": True, "model": cfg.grader_model, **c.cloud.tiny_message(cfg.grader_model)}
        except LLMError as e:
            result["message_test"] = {"ok": False, "model": cfg.grader_model, "code": e.code, "message": e.message}
    c.ai.save_test(result)
    return result
