from __future__ import annotations

import platform
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request

from ..config import setup_cmd
from ..services.ollama import LLMError
from ..services.stats import build_stats
from ..services.sysmem import memory_advice, read_memory
from ..services.usage import loaded_models
from ..services.tts import SpeechError

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health(request: Request) -> dict[str, Any]:
    c = request.app.state.c
    s = c.settings
    out: dict[str, Any] = {
        "app": "ok", "bind": f"{s.host}:{s.port}", "local_only": True,
        "ollama": {"ok": False, "host": s.ollama_host, "version": None, "error": None},
        "llm": {"model": s.llm_model, "installed": False, "loaded": False, "error": None},
        "tts": {"model": s.tts_model, "provider": s.tts_provider, "engine": "phonon" if s.tts_provider == "phonon" else "system",
                "installed": False, "voices": 0, "error": None, "note": None},
        "stt": c.stt.status(),
        "platform": f"{platform.system()} {platform.machine()}",
        "memory": None,
        "ai": _ai_status(c),
        "ocr": _ocr(s),
    }
    tts = out["tts"]
    try:
        out["ollama"]["version"] = c.ollama.version()
        out["ollama"]["ok"] = True
        installed = c.ollama.list_models()
        names = {m.get("name") for m in installed}
        out["llm"]["installed"] = s.llm_model in names or f"{s.llm_model}:latest" in names
        tts["installed"] = s.tts_model in names or f"{s.tts_model}:latest" in names
        out["llm"]["loaded"] = any(m.get("name") == s.llm_model for m in c.ollama.running())
        if not out["llm"]["installed"]:
            out["llm"]["error"] = f"Model '{s.llm_model}' is not installed. Run {setup_cmd()}"
        _tts_status(c, out["tts"], phonon_installed=out["tts"]["installed"])
        disk_gb = next((m.get("size", 0) for m in installed if m.get("name") in (s.llm_model, f"{s.llm_model}:latest")), 0) / 2**30
        out["memory"] = memory_advice(read_memory(), (disk_gb or 4.0) + 0.3, out["llm"]["loaded"])
    except LLMError as e:
        out["ollama"]["error"] = e.message
    if tts["engine"] == "system":
        tts["note"] = SYSTEM_NOTE
        if s.tts_provider == "auto" and tts["error"]:   # Phonon is optional: fall back quietly
            tts["error"] = None
    return out


def _ocr(s) -> dict[str, Any]:
    """Optional Tesseract OCR for scanned resumes (cached; never blocks anything)."""
    from ..services.resume_extract import ocr_status
    st = ocr_status(s)
    return {k: st[k] for k in ("available", "enabled", "version", "reason", "install", "install_all", "os")}


def _ai_status(c) -> dict[str, Any]:
    """Which engine runs the interview and whether it is set up. Reads settings only: health never calls the cloud."""
    cfg, key = c.ai.get(), c.ai.key_info()
    cloud_ready = key["set"] and bool(cfg.cloud_consent_at)
    return {"mode": cfg.mode, "processing": "cloud" if cfg.mode == "cloud" else "local", "ready": cloud_ready if cfg.mode == "cloud" else None,
            "grader_model": cfg.grader_model if cfg.mode == "cloud" else None, "key_set": key["set"], "consented": bool(cfg.cloud_consent_at),
            "budget": c.gateway.budget_status(cfg) if cfg.mode == "cloud" else None, "last_test_ok": (c.ai.last_test() or {}).get("ok")}


SYSTEM_NOTE = ("Using your computer's built-in offline voices (through the browser). "
               "The premium Phonon voice is optional and needs an Apple Silicon Mac.")


def _tts_status(c, tts: dict[str, Any], *, phonon_installed: bool) -> None:
    """Fills tts{engine,voices,error}. `auto` prefers Phonon when it works, otherwise the system voices."""
    s = c.settings
    if s.tts_provider == "system":
        return
    if phonon_installed:
        try:
            tts["voices"] = len(c.speech.voices())
            tts["engine"] = "phonon"
        except SpeechError as e:
            tts["error"] = e.message
    else:
        tts["error"] = f"Model '{s.tts_model}' is not installed. Run {setup_cmd()}"


@router.get("/voices")
def voices(request: Request) -> dict[str, Any]:
    from ..errors import AppError

    c = request.app.state.c
    if c.settings.tts_provider != "system":
        try:
            names = c.speech.voices(force=True)
            return {"engine": "phonon", "voices": names, "default": "default" if "default" in names else names[0],
                    "speed_supported": False,
                    "speed_note": "Phonon only supports normal speed; playback speed is applied by the browser's audio player."}
        except SpeechError as e:
            if c.settings.tts_provider == "phonon":
                raise AppError(503 if e.code in {"ollama_unavailable", "model_missing"} else 502, e.code, e.message) from e
    # the browser lists the offline voices itself (speechSynthesis); nothing is generated or sent anywhere
    return {"engine": "system", "voices": [], "default": "default", "speed_supported": True, "speed_note": SYSTEM_NOTE}


@router.get("/stats")
def stats(request: Request) -> dict[str, Any]:
    """Progress overview for the Home dashboard (local data only)."""
    return build_stats(request.app.state.c.db)


@router.post("/llm/warm")
def warm(request: Request, background: BackgroundTasks) -> dict[str, str]:
    """Load the interview model in the background (a few seconds after an interview starts) and keep it from expiring while an
    interview is open. Cheap when the model is already loaded. Safe to call repeatedly."""
    c = request.app.state.c
    if c.gateway.is_cloud():
        return {"status": "cloud"}                          # cloud models need no loading; nothing is asked of the local Ollama
    loaded = c.ollama.is_loaded(c.settings.llm_model)
    background.add_task(c.ollama.warm, c.settings.llm_model)      # when loaded this just restarts the idle timer
    return {"status": "loaded" if loaded else "loading"}


@router.get("/usage")
def usage(request: Request, limit: int = 30, range: str = "all", provider: str = "all") -> dict[str, Any]:
    """Tokens and time per model and task, the latest calls, and what is in memory now (like `ollama ps`). Numbers only."""
    c = request.app.state.c
    rng = "today" if range == "today" else "all"
    prov = provider if provider in ("local", "cloud") else None
    cfg = c.ai.get()
    return {"range": rng, "provider": prov or "all", "mode": cfg.mode, "loaded": loaded_models(c.ollama.running()), "summary": c.usage.summary(rng, prov),
            "recent": c.usage.recent(limit, rng, prov), "totals": c.usage.totals(), "budget": c.gateway.budget_status(cfg),
            "prices_note": "Cloud costs are estimates from the prices in Settings -> AI models (reasoning tokens and cached input may be billed differently)."}


@router.delete("/usage")
def clear_usage(request: Request) -> dict[str, int]:
    return {"deleted": request.app.state.c.usage.clear()}
