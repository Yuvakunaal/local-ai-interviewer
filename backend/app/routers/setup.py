"""First-run setup: what is missing on this computer, and a one-click download of the interview model."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..errors import AppError
from ..services.model_pull import PullError
from ..services.setup_check import build_setup_report
from . import system

router = APIRouter(prefix="/api/setup", tags=["setup"])


@router.get("")
def setup_report(request: Request) -> dict[str, Any]:
    c = request.app.state.c
    health = system.health(request)
    key, cfg = c.ai.key_info(), c.ai.get()
    return build_setup_report(c.settings, health, cloud_key_ready=bool(key["set"] and cfg.cloud_consent_at))


class PullIn(BaseModel):
    which: Literal["llm", "tts"] = "llm"


@router.post("/pull")
def start_pull(body: PullIn, request: Request) -> dict[str, Any]:
    try:
        return request.app.state.c.puller.start(body.which)
    except PullError as e:
        raise AppError(e.status, e.code, e.message) from e


@router.get("/pull")
def pull_status(request: Request) -> dict[str, Any]:
    return request.app.state.c.puller.status()


@router.delete("/pull")
def cancel_pull(request: Request) -> dict[str, Any]:
    return request.app.state.c.puller.cancel()
