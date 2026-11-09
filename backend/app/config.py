"""Runtime configuration. Everything is local; non-loopback Ollama hosts are refused."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
TTS_PROVIDERS = ("auto", "phonon", "system")


def setup_cmd(args: str = "") -> str:
    """The command that runs the model installer on this OS, for user-facing hints."""
    base = "setup-models.bat" if os.name == "nt" else "./setup-models.sh"
    return f"{base} {args}".strip()


def parse_env_value(raw: str) -> str:
    """`"quoted # kept"` -> quoted # kept;  `base.en   # note` -> base.en  (same rules as scripts/manage.py)."""
    v = raw.strip()
    if v[:1] in {'"', "'"}:
        end = v.find(v[0], 1)
        return v[1:end] if end > 0 else v[1:]
    cut = v.find(" #")
    return (v[:cut] if cut >= 0 else v).strip()


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader (no dependency). Real environment variables win."""
    path = path or ROOT / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), parse_env_value(value))


def is_loopback_url(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return host in LOOPBACK_HOSTS


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 3000
    ollama_host: str = "http://127.0.0.1:11434"
    llm_model: str = "qwen3.5:4b"
    tts_model: str = "phonon"
    tts_provider: str = "auto"   # auto: Phonon when available, else the browser's offline system voices
    stt_model: str = "base.en"
    data_dir: Path = field(default_factory=lambda: ROOT / "data")
    frontend_dist: Path = field(default_factory=lambda: ROOT / "frontend" / "dist")
    llm_num_ctx: int = 6144
    llm_max_tokens: int = 1400
    llm_temperature: float = 0.2
    llm_timeout_s: int = 240
    llm_idle_timeout_s: int = 90
    llm_keep_alive: str = "10m"
    llm_unload_when_idle: bool = True   # free the model's RAM as soon as no interview is running (pause / finish / end)
    tts_timeout_s: int = 60
    audio_cache_mb: int = 200
    stt_enabled: bool = True
    cloud_url: str = "https://ollama.com"       # Ollama cloud API (used ONLY when the user switches to cloud mode and consents)
    cloud_timeout_s: int = 150
    cloud_idle_timeout_s: int = 90
    cloud_max_tokens: int = 3000                # reasoning models spend part of this on thinking, so it is larger than the local cap
    resume_max_mb: int = 10                     # largest resume PDF accepted
    resume_max_pages: int = 15                  # longest resume PDF accepted
    ocr_enabled: bool = True                    # read scanned (image-only) pages with Tesseract when it is installed
    ocr_langs: str = "eng"                      # Tesseract language codes, e.g. "eng" or "eng+deu"
    tesseract_cmd: str = ""                     # optional full path to the tesseract program (otherwise it is looked up)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "interviewer.sqlite3"

    @property
    def audio_cache_dir(self) -> Path:
        return self.data_dir / "audio_cache"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "tmp_uploads"

    @property
    def resumes_dir(self) -> Path:
        return self.data_dir / "resumes"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        ollama = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434").rstrip("/")
        if not is_loopback_url(ollama) and os.environ.get("ALLOW_NON_LOCAL_OLLAMA") != "1":
            raise RuntimeError(
                f"Refusing OLLAMA_HOST_URL={ollama!r}: only loopback hosts are allowed so interview "
                "content never leaves this machine."
            )
        cloud_url = os.environ.get("OLLAMA_CLOUD_URL", "https://ollama.com").strip().rstrip("/")
        if not (cloud_url.startswith("https://") or (cloud_url.startswith("http://") and is_loopback_url(cloud_url))):
            raise RuntimeError("OLLAMA_CLOUD_URL must be https:// (plain http is only accepted for a loopback test server).")
        data_dir = Path(os.environ.get("DATA_DIR", ROOT / "data")).expanduser()
        provider = os.environ.get("TTS_PROVIDER", "auto").strip().lower() or "auto"
        if provider not in TTS_PROVIDERS:
            raise RuntimeError(f"TTS_PROVIDER must be one of {', '.join(TTS_PROVIDERS)} (got {provider!r}).")
        return cls(
            host=os.environ.get("APP_HOST", "127.0.0.1"),
            port=_env_int("APP_PORT", 3000),
            ollama_host=ollama,
            llm_model=os.environ.get("LLM_MODEL", "qwen3.5:4b"),
            tts_model=os.environ.get("TTS_MODEL", "phonon"),
            tts_provider=provider,
            stt_model=os.environ.get("STT_MODEL", "base.en"),
            data_dir=data_dir if data_dir.is_absolute() else ROOT / data_dir,
            llm_num_ctx=_env_int("LLM_NUM_CTX", 6144),
            llm_max_tokens=_env_int("LLM_MAX_TOKENS", 1400),
            llm_temperature=_env_float("LLM_TEMPERATURE", 0.2),
            llm_timeout_s=_env_int("LLM_TIMEOUT_S", 240),
            llm_idle_timeout_s=_env_int("LLM_IDLE_TIMEOUT_S", 90),
            llm_keep_alive=os.environ.get("LLM_KEEP_ALIVE", "10m"),
            llm_unload_when_idle=os.environ.get("LLM_UNLOAD_WHEN_IDLE", "1") != "0",
            tts_timeout_s=_env_int("TTS_TIMEOUT_S", 60),
            audio_cache_mb=_env_int("AUDIO_CACHE_MB", 200),
            stt_enabled=os.environ.get("STT_ENABLED", "1") != "0",
            cloud_url=cloud_url,
            cloud_timeout_s=_env_int("CLOUD_TIMEOUT_S", 150),
            cloud_idle_timeout_s=_env_int("CLOUD_IDLE_TIMEOUT_S", 90),
            cloud_max_tokens=_env_int("CLOUD_MAX_TOKENS", 3000),
            resume_max_mb=max(1, min(_env_int("RESUME_MAX_MB", 10), 50)),
            resume_max_pages=max(1, min(_env_int("RESUME_MAX_PAGES", 15), 60)),
            ocr_enabled=os.environ.get("OCR_ENABLED", "1") != "0",
            ocr_langs=os.environ.get("OCR_LANGS", "eng").strip() or "eng",
            tesseract_cmd=os.environ.get("TESSERACT_CMD", "").strip(),
        )
