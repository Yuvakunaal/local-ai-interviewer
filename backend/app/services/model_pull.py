"""Downloads the interview model (or the Phonon voice) when the user presses the button on the setup screen.

One download at a time, run in the background so the page can show progress and the user can cancel. Only the models this app is
configured to use can be pulled, and nothing starts unless the user asked for it.
"""
from __future__ import annotations

import threading
from typing import Any, Optional

from ..config import Settings
from .ollama import LLMError, OllamaClient
from .setup_check import FREE_DISK_NEEDED_GB, MODEL_GB, free_gb


class PullError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class ModelPuller:
    def __init__(self, ollama: OllamaClient, settings: Settings):
        self.ollama, self.settings = ollama, settings
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._cancel = threading.Event()
        self._state: dict[str, Any] = {"state": "idle", "model": None, "status": "", "completed": 0, "total": 0, "error": None}

    # ---------------------------------------------------------------- public
    def allowed(self) -> dict[str, str]:
        return {"llm": self.settings.llm_model, "tts": self.settings.tts_model}

    def status(self) -> dict[str, Any]:
        with self._lock:
            s = dict(self._state)
        s["percent"] = round(100 * s["completed"] / s["total"]) if s["total"] else None
        return s

    def start(self, which: str) -> dict[str, Any]:
        model = self.allowed().get(which)
        if not model:
            raise PullError("unknown_model", "Only the interview model or the voice model can be downloaded here.")
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise PullError("pull_running", f"“{self._state['model']}” is already downloading.", 409)
        disk = free_gb()
        need = MODEL_GB.get(model, 1.0 if which == "tts" else FREE_DISK_NEEDED_GB) + 1.0
        if disk is not None and disk < need:
            raise PullError("disk_full", f"Not enough free disk space: {disk:.1f} GB free, about {need:.0f} GB needed. Free some space and try again.", 507)
        try:
            self.ollama.version()
        except LLMError as e:
            raise PullError("ollama_unavailable", e.message, 503) from e
        self._cancel.clear()
        with self._lock:
            self._state = {"state": "pulling", "model": model, "status": "Starting…", "completed": 0, "total": 0, "error": None}
            self._thread = threading.Thread(target=self._run, args=(model,), name="model-pull", daemon=True)
            self._thread.start()
        return self.status()

    def cancel(self) -> dict[str, Any]:
        self._cancel.set()
        return self.status()

    def wait(self, timeout: float = 10.0) -> None:       # tests
        t = self._thread
        if t:
            t.join(timeout)

    # ---------------------------------------------------------------- worker
    def _run(self, model: str) -> None:
        try:
            stream = self.ollama.pull_stream(model)
            for ev in stream:
                if self._cancel.is_set():
                    stream.close()
                    with self._lock:
                        self._state.update(state="cancelled", status="Cancelled. What was downloaded is kept, so starting again resumes.")
                    return
                with self._lock:
                    self._state["status"] = str(ev.get("status") or self._state["status"])
                    if ev.get("total"):                      # each layer reports its own total; show the layer being fetched
                        self._state["total"], self._state["completed"] = int(ev["total"]), int(ev.get("completed") or 0)
                    if ev.get("status") == "success":
                        self._state.update(state="done", completed=self._state["total"] or 1, total=self._state["total"] or 1)
            with self._lock:
                if self._state["state"] == "pulling":
                    self._state.update(state="done")
        except LLMError as e:
            with self._lock:
                self._state.update(state="error", error=e.message)
        except Exception:        # never let a download problem take the app down
            with self._lock:
                self._state.update(state="error", error="The download stopped unexpectedly. Try again.")
