"""Optional local speech recognition (faster-whisper). Never downloads at runtime and never goes online."""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional

from ..config import Settings, setup_cmd

log = logging.getLogger("interviewer.stt")


# Whisper is biased towards these spellings, which fixes most jargon errors ("idempotency" heard as "item potency", "InnoDB" as "NODB").
# KEEP IT SHORT: Whisper only uses the LAST 223 tokens of an initial prompt and silently drops the start, so a longer list
# makes the first (most important) terms stop working. Measured: 130 tokens now; a 250-token version broke "idempotency".
VOCAB_PROMPT = ("Technical interview. Terms: idempotency, idempotent, latency, throughput, concurrency, deadlock, mutex, race condition, big-O, "
                "microservices, Kubernetes, Docker, CI/CD, Terraform, REST, GraphQL, gRPC, OAuth, JWT, TypeScript, React, Python, "
                "SQL, NoSQL, MySQL, PostgreSQL, InnoDB, ACID, GROUP BY, CAP theorem, Redis, Kafka, ETL, CDC, Apache Spark, upsert, MERGE, CTE, "
                "machine learning, overfitting, embeddings, API, AWS, S3, DDL, DML, primary key, foreign key.")


class TranscribeError(Exception):
    """code: stt_unavailable | stt_model_missing | empty_audio | failed"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class TranscriptionService:
    IDLE_UNLOAD_S = 300

    def __init__(self, settings: Settings):
        self.settings = settings
        self._model: Any = None
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        # Hard guarantee: huggingface_hub may not touch the network from this process.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    # ---------------------------------------------------------------- availability
    def _import(self):
        try:
            import faster_whisper  # noqa: F401

            return faster_whisper
        except ImportError:
            return None

    def status(self) -> dict[str, Any]:
        if not self.settings.stt_enabled:
            return {"available": False, "model": self.settings.stt_model, "reason": "Disabled (STT_ENABLED=0)."}
        if self._import() is None:
            return {"available": False, "model": self.settings.stt_model,
                    "reason": f"faster-whisper is not installed. Run {setup_cmd('--stt')}"}
        if not self._model_cached():
            return {"available": False, "model": self.settings.stt_model,
                    "reason": f"Whisper model '{self.settings.stt_model}' is not downloaded. Run {setup_cmd('--stt')}"}
        return {"available": True, "model": self.settings.stt_model, "reason": None}

    def _model_cached(self) -> bool:
        name = self.settings.stt_model
        if Path(name).is_dir():
            return True
        try:
            from faster_whisper.utils import _MODELS  # repo ids per model size

            repo = _MODELS.get(name, name)
            from huggingface_hub import try_to_load_from_cache

            return isinstance(try_to_load_from_cache(repo, "model.bin"), str)
        except Exception:
            return False

    # ---------------------------------------------------------------- transcription
    def transcribe(self, audio_path: str) -> str:
        st = self.status()
        if not st["available"]:
            code = "stt_unavailable" if "not installed" in (st["reason"] or "") or "Disabled" in (st["reason"] or "") else "stt_model_missing"
            raise TranscribeError(code, st["reason"] or "Speech recognition is unavailable.")
        with self._lock:
            try:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    self._model = WhisperModel(self.settings.stt_model, device="cpu", compute_type="int8",
                                               cpu_threads=4, local_files_only=True)
                segments, _info = self._model.transcribe(audio_path, language="en", beam_size=1,
                                                         vad_filter=True, condition_on_previous_text=False,
                                                         initial_prompt=VOCAB_PROMPT)
                text = " ".join(s.text.strip() for s in segments).strip()
            except TranscribeError:
                raise
            except Exception as e:
                log.warning("transcription failed: %s", type(e).__name__)
                raise TranscribeError("failed", f"Could not transcribe the recording ({type(e).__name__}). "
                                                "The audio may be unreadable.") from e
            finally:
                self._schedule_unload()
        if not text:
            raise TranscribeError("empty_audio", "No speech was detected in the recording.")
        return text

    def _schedule_unload(self) -> None:
        if self._timer:
            self._timer.cancel()
        self._timer = threading.Timer(self.IDLE_UNLOAD_S, self._unload)
        self._timer.daemon = True
        self._timer.start()

    def _unload(self) -> None:
        with self._lock:
            self._model = None
