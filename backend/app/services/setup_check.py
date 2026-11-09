"""First-run check: is this computer ready to run the interviewer, and if not, exactly what to install?

Read-only and local: it looks at files and the local Ollama, never at the internet. The links below are documentation pages the user
may click to install a tool; the app itself never requests them (see test_local_only for the allow-list).
"""
from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path
from typing import Any, Optional

from ..config import Settings, setup_cmd

OLLAMA_DOWNLOAD = "https://ollama.com/download"
OLLAMA_LINUX_INSTALL = "curl -fsSL https://ollama.com/install.sh | sh"
PYTHON_DOWNLOAD = "https://www.python.org/downloads/"
NODE_DOWNLOAD = "https://nodejs.org/"

MODEL_GB = {"qwen3.5:4b": 4.0}       # approximate download sizes shown before anything is pulled
FREE_DISK_NEEDED_GB = 6.0
RAM_COMFORT_GB = 7.0


def os_key() -> str:
    return {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), "linux")


def find_ollama() -> Optional[str]:
    found = shutil.which("ollama")
    if found:
        return found
    system = os_key()
    if system == "windows":
        candidates = [Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"]
    elif system == "macos":
        candidates = [Path("/Applications/Ollama.app/Contents/Resources/ollama"), Path("/opt/homebrew/bin/ollama"), Path("/usr/local/bin/ollama")]
    else:
        candidates = [Path("/usr/local/bin/ollama"), Path("/usr/bin/ollama")]
    return next((str(c) for c in candidates if c.is_file()), None)


def models_dir() -> Path:
    return Path(os.environ.get("OLLAMA_MODELS") or Path.home() / ".ollama")


def free_gb(path: Optional[Path] = None) -> Optional[float]:
    p = path or models_dir()
    while not p.exists() and p != p.parent:
        p = p.parent
    try:
        return shutil.disk_usage(p).free / 2**30
    except OSError:
        return None


def total_gb(memory: Optional[dict]) -> Optional[float]:
    return (memory or {}).get("total_gb")


def ollama_install_help(system: str) -> dict[str, Any]:
    if system == "windows":
        steps = [{"title": "Download and run the Ollama installer", "url": OLLAMA_DOWNLOAD}, {"title": "or, in a terminal", "command": "winget install Ollama.Ollama"}]
    elif system == "macos":
        steps = [{"title": "Download Ollama and drag it to Applications", "url": OLLAMA_DOWNLOAD}, {"title": "or, with Homebrew", "command": "brew install ollama"}]
    else:
        steps = [{"title": "Install Ollama in a terminal", "command": OLLAMA_LINUX_INSTALL}, {"title": "More options", "url": OLLAMA_DOWNLOAD}]
    return {"summary": "Ollama runs the AI model on your computer. Install it, open it once, then come back and press Check again.", "steps": steps}


def ollama_start_help(system: str) -> dict[str, Any]:
    how = {"macos": "Open the Ollama app (it lives in the menu bar).", "windows": "Open Ollama from the Start menu (it lives in the system tray)."}.get(system, "")
    steps = ([{"title": how}] if how else []) + [{"title": "or, in a terminal", "command": "ollama serve"}]
    return {"summary": "Ollama is installed but not running.", "steps": steps}


def build_setup_report(settings: Settings, health: dict[str, Any], *, cloud_key_ready: bool) -> dict[str, Any]:
    system = os_key()
    ai = health["ai"]
    cloud_mode = ai["mode"] == "cloud"
    ollama_ok = health["ollama"]["ok"]
    model_ok = health["llm"]["installed"]
    exe = find_ollama()
    items: list[dict[str, Any]] = []

    items.append({"id": "python", "label": "Python", "required": True, "status": "ok", "detail": f"{platform.python_version()} (running this app)"})

    if not cloud_mode:
        if ollama_ok:
            items.append({"id": "ollama", "label": "Ollama", "required": True, "status": "ok", "detail": f"version {health['ollama']['version']}"})
        elif exe:
            items.append({"id": "ollama", "label": "Ollama", "required": True, "status": "missing", "detail": "installed, but not running", "help": ollama_start_help(system)})
        else:
            items.append({"id": "ollama", "label": "Ollama", "required": True, "status": "missing", "detail": "not installed", "help": ollama_install_help(system)})
        gb = MODEL_GB.get(settings.llm_model)
        size = f"about {gb:g} GB download" if gb else "a few GB to download"
        if model_ok:
            items.append({"id": "model", "label": f"Interview model ({settings.llm_model})", "required": True, "status": "ok", "detail": "installed"})
        else:
            items.append({"id": "model", "label": f"Interview model ({settings.llm_model})", "required": True, "status": "missing",
                          "detail": size if ollama_ok else f"{size}; needs Ollama running first", "action": "pull_llm" if ollama_ok else None,
                          "help": {"summary": "This is the AI that listens to your answers and grades them, on your own computer.",
                                   "steps": [{"title": ("Press the download button above, or run this in a terminal" if ollama_ok else "Once Ollama is running you can download it here with one click, or run this in a terminal"), "command": setup_cmd()}]}})
    else:
        items.append({"id": "cloud", "label": "Ollama cloud", "required": True, "status": "ok" if cloud_key_ready else "missing",
                      "detail": "API key saved and consent given" if cloud_key_ready else "add your API key in Settings → AI models", "action": None if cloud_key_ready else "open_ai_settings"})

    tts = health["tts"]
    if tts["engine"] == "phonon":
        items.append({"id": "voice", "label": "Voice", "required": False, "status": "ok", "detail": f"Phonon · {tts['voices']} voices"})
    else:
        items.append({"id": "voice", "label": "Voice", "required": False, "status": "ok", "detail": "your computer's own offline voices (works in Chrome or Edge)"})

    stt = health["stt"]
    items.append({"id": "mic", "label": "Microphone answers", "required": False, "status": "ok" if stt.get("available") else "optional",
                  "detail": f"offline Whisper “{stt.get('model')}”" if stt.get("available") else "optional: you can always type your answers",
                  **({} if stt.get("available") else {"help": {"summary": "To also speak your answers, install the offline speech recogniser.", "steps": [{"title": "In a terminal", "command": setup_cmd("--stt")}]}})})

    from .resume_extract import INSTALL_COMMANDS, ocr_status   # (imported here: resume_extract imports os_key from this module)
    ocr = health.get("ocr") or ocr_status(settings)
    items.append({"id": "ocr", "label": "Resume OCR (Tesseract)", "required": False, "status": "ok" if ocr["available"] else "optional",
                  "detail": (f"{ocr.get('version') or 'Tesseract'} · reads scanned resumes" if ocr["available"]
                             else f"optional: only needed for scanned (image-only) resume PDFs — {ocr.get('reason') or 'not installed'}"),
                  **({} if ocr["available"] else {"help": {"summary": "Typed resume PDFs work without it. To also read scanned ones, install the free OCR program Tesseract, then press Check again.",
                                                            "steps": [{"title": "In a terminal", "command": INSTALL_COMMANDS.get(system, INSTALL_COMMANDS["linux"])}]}})})

    disk = free_gb()
    if disk is not None and not cloud_mode:
        low = disk < FREE_DISK_NEEDED_GB and not model_ok
        items.append({"id": "disk", "label": "Free disk space", "required": False, "status": "warn" if low else "ok",
                      "detail": f"{disk:.0f} GB free" + (f" — the model needs about {MODEL_GB.get(settings.llm_model, 4):g} GB" if low else "")})
    ram = total_gb(health.get("memory"))
    if ram is not None and not cloud_mode:
        tight = ram < RAM_COMFORT_GB
        items.append({"id": "memory", "label": "Memory (RAM)", "required": False, "status": "warn" if tight else "ok",
                      "detail": f"{ram:.0f} GB" + (" — tight for a local model; cloud models avoid this" if tight else "")})

    local_ready = ollama_ok and model_ok
    ready = cloud_key_ready if cloud_mode else local_ready
    return {
        "os": system, "ready": ready, "needs_setup": not ready, "mode": ai["mode"], "local_ready": local_ready,
        "items": items,
        "blocking": [i["id"] for i in items if i["required"] and i["status"] != "ok"],
        "alternatives": {"cloud_key_ready": cloud_key_ready},
        "downloads": {"model": settings.llm_model, "size_gb": MODEL_GB.get(settings.llm_model), "free_gb": disk},
    }
