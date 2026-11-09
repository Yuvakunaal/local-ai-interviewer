"""Phonon speech synthesis through Ollama's /v1/audio/speech endpoint.

Verified behaviour of the installed model (Ollama 0.40.x, phonon:latest):
  * POST /v1/audio/speech {model, input, voice, response_format: wav|pcm} -> 24 kHz, mono, 16-bit PCM
  * only speed 1 is accepted (speed is therefore applied client-side by the audio element)
  * unknown voice -> HTTP 400 listing available voices; empty input -> HTTP 400
  * the WAV it streams carries a placeholder length in its header, so we request raw PCM and write
    our own correct WAV header.
"""
from __future__ import annotations

import hashlib
import logging
import re
import struct
import threading
import time
from pathlib import Path
from typing import Optional

import httpx

from ..config import Settings, setup_cmd
from .ollama import OllamaClient, _unavailable_msg

log = logging.getLogger("interviewer.tts")

SAMPLE_RATE = 24000
CHUNK_CHARS = 380
GAP_MS = 180


class SpeechError(Exception):
    """code: ollama_unavailable | model_missing | bad_voice | empty_audio | timeout | failed"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def chunk_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Split on sentence boundaries into chunks <= limit chars (hard-splitting overlong sentences)."""
    text = re.sub(r"\s+", " ", text).strip()
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        while len(s) > limit:
            cut = s.rfind(" ", 0, limit)
            cut = cut if cut > 40 else limit
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(s[:cut].strip())
            s = s[cut:].strip()
        if cur and len(cur) + 1 + len(s) > limit:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return [c for c in chunks if c]


def wav_from_pcm(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def pcm_is_silent(pcm: bytes) -> bool:
    if len(pcm) < 1200:  # < 25 ms
        return True
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    return max(abs(s) for s in samples[:: max(1, n // 4000)]) < 8


class SpeechService:
    def __init__(self, settings: Settings, ollama: OllamaClient):
        self.settings = settings
        self.ollama = ollama
        self.cache_dir = settings.audio_cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()  # one synthesis at a time keeps memory flat
        self._voices: tuple[float, list[str]] = (0.0, [])

    # ---------------------------------------------------------------- voices
    def voices(self, force: bool = False) -> list[str]:
        now = time.monotonic()
        if not force and self._voices[1] and now - self._voices[0] < 60:
            return self._voices[1]
        try:
            info = self.ollama.show(self.settings.tts_model)
        except Exception as e:
            code = getattr(e, "code", "failed")
            raise SpeechError(code if code in {"ollama_unavailable", "model_missing"} else "failed",
                              getattr(e, "message", str(e))) from e
        if "speech" not in (info.get("capabilities") or []):
            raise SpeechError("model_missing", f"Model '{self.settings.tts_model}' has no speech capability.")
        voices = [v for v in info.get("voices") or [] if isinstance(v, str)]
        if not voices:
            raise SpeechError("failed", "The speech model reports no voices.")
        self._voices = (now, voices)
        return voices

    # ---------------------------------------------------------------- synthesis
    def _cache_path(self, text: str, voice: str) -> Path:
        key = hashlib.sha256(f"{self.settings.tts_model}\0{voice}\0{text}".encode()).hexdigest()[:40]
        return self.cache_dir / f"{key}.wav"

    def synthesize(self, text: str, voice: str) -> bytes:
        text = re.sub(r"\s+", " ", text or "").strip()
        if not text:
            raise SpeechError("failed", "There is no text to speak.")
        if voice not in self.voices():
            raise SpeechError("bad_voice", f"Voice '{voice}' is not available in {self.settings.tts_model}.")
        path = self._cache_path(text, voice)
        if path.is_file() and path.stat().st_size > 100:
            path.touch()
            return path.read_bytes()
        with self._lock:
            if path.is_file():  # generated while we waited
                return path.read_bytes()
            started = time.monotonic()
            pcm = self._generate(text, voice)
            self._report_usage(text, pcm, time.monotonic() - started)
        wav = wav_from_pcm(pcm)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(wav)
        tmp.replace(path)
        self._prune()
        return wav

    def _report_usage(self, text: str, pcm: bytes, seconds: float) -> None:
        """Speech has no tokens; record how long it took and how much audio it made (cached replays are not recorded)."""
        sink = getattr(self.ollama, "on_usage", None)
        if sink:
            try:
                sink({"model": self.settings.tts_model, "purpose": "speech", "total_ms": int(seconds * 1000),
                      "detail": f"{len(text)} characters, {len(pcm) / (SAMPLE_RATE * 2):.1f} s of audio"})
            except Exception:
                log.debug("could not report speech usage", exc_info=True)

    def _generate(self, text: str, voice: str) -> bytes:
        silence = b"\x00\x00" * (SAMPLE_RATE * GAP_MS // 1000)
        out: list[bytes] = []
        for chunk in chunk_text(text):
            pcm = self._request(chunk, voice)
            if pcm_is_silent(pcm):
                raise SpeechError("empty_audio", "The speech model returned empty audio.")
            out.append(pcm)
        return silence.join(out)

    def _request(self, text: str, voice: str) -> bytes:
        body = {"model": self.settings.tts_model, "input": text, "voice": voice, "response_format": "pcm"}
        try:
            r = self.ollama.http.post("/v1/audio/speech", json=body, timeout=self.settings.tts_timeout_s)
        except httpx.ConnectError as e:
            raise SpeechError("ollama_unavailable", _unavailable_msg(self.settings)) from e
        except httpx.TimeoutException as e:
            raise SpeechError("timeout", "Speech generation timed out.") from e
        except httpx.HTTPError as e:
            raise SpeechError("failed", f"Speech request failed: {type(e).__name__}") from e
        if r.status_code != 200:
            msg = r.text[:300]
            if r.status_code == 404:
                raise SpeechError("model_missing", f"Speech model '{self.settings.tts_model}' is not installed. Run {setup_cmd()}")
            if "voice" in msg and "not found" in msg:
                raise SpeechError("bad_voice", f"Voice '{voice}' is not available.")
            raise SpeechError("failed", f"Speech generation failed (HTTP {r.status_code}).")
        return r.content

    def _prune(self) -> None:
        limit = self.settings.audio_cache_mb * 1024 * 1024
        files = sorted(self.cache_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > limit:
            victim = files.pop(0)
            total -= victim.stat().st_size
            victim.unlink(missing_ok=True)

    def clear_cache(self) -> int:
        n = 0
        for p in self.cache_dir.glob("*.wav"):
            p.unlink(missing_ok=True)
            n += 1
        return n
