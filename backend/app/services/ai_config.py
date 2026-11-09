"""Which AI runs the interview: the local Ollama model (default, private) or Ollama cloud models (opt-in, uses the user's credits).

Stored in the local database's `settings` table. The API key is kept apart from the rest of the configuration and is NEVER returned
by any API: the UI only ever sees whether a key exists, where it came from, and its last four characters.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from ..db import Database, utcnow
from ..errors import AppError
from .pricing import DEFAULT_PRICES, ModelPrice

CONFIG_KEY, SECRET_KEY, TEST_KEY = "ai_config", "ai_cloud_key", "ai_last_test"
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,79}$")
MAX_PRICES = 150


def _default_prices() -> dict[str, ModelPrice]:
    return {k: v.model_copy() for k, v in DEFAULT_PRICES.items()}


class AIConfig(BaseModel):
    mode: Literal["local", "cloud"] = "local"
    cloud_consent_at: Optional[str] = None            # when the user agreed that their text is sent to Ollama's servers
    grader_model: str = "gpt-oss:120b"                # grades answers, writes feedback and the report summary
    fallback_model: str = "deepseek-v4.1-flash"       # used automatically if the grader fails (and a good alternative grader)
    use_fallback: bool = True
    conversation_model: str = "gemma4:31b"            # writes follow-up questions and cleans up voice transcripts
    fallback_to_local: bool = False                   # if the cloud fails, use the local model instead (never the other way round)
    enforce_budget: bool = True
    daily_budget_usd: Optional[float] = Field(default=1.0, ge=0, le=100_000)
    total_budget_usd: Optional[float] = Field(default=None, ge=0, le=100_000)
    prices: dict[str, ModelPrice] = Field(default_factory=_default_prices)

    @field_validator("grader_model", "fallback_model", "conversation_model")
    @classmethod
    def _model(cls, v: str) -> str:
        v = (v or "").strip()
        if not MODEL_NAME.match(v):
            raise ValueError("Use a model name like gpt-oss:120b (letters, digits and . : - _ / only).")
        return v

    @model_validator(mode="after")
    def _prices(self) -> "AIConfig":
        if len(self.prices) > MAX_PRICES:
            raise ValueError("Too many price entries.")
        for name in self.prices:
            if not MODEL_NAME.match(name):
                raise ValueError(f"Invalid model name in the price list: {name!r}")
        return self


class AIConfigUpdate(BaseModel):
    """Partial update from the Settings page. `acknowledge_cloud` records the user's informed consent."""

    mode: Optional[Literal["local", "cloud"]] = None
    acknowledge_cloud: bool = False
    grader_model: Optional[str] = None
    fallback_model: Optional[str] = None
    use_fallback: Optional[bool] = None
    conversation_model: Optional[str] = None
    fallback_to_local: Optional[bool] = None
    enforce_budget: Optional[bool] = None
    daily_budget_usd: Optional[float] = Field(default=None, ge=0, le=100_000)
    total_budget_usd: Optional[float] = Field(default=None, ge=0, le=100_000)
    clear_daily_budget: bool = False
    clear_total_budget: bool = False
    prices: Optional[dict[str, ModelPrice]] = None


def clean_key(raw: str) -> str:
    key = (raw or "").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not 8 <= len(key) <= 512 or re.search(r"\s", key) or not key.isprintable():
        raise AppError(422, "invalid_key", "That does not look like an API key. Paste it exactly as shown on ollama.com/settings/keys (no spaces).")
    return key


class AIConfigStore:
    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------ configuration
    def get(self) -> AIConfig:
        with self.db.read() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (CONFIG_KEY,)).fetchone()
        if not row:
            return AIConfig()
        try:
            cfg = AIConfig.model_validate(json.loads(row[0]))
            cfg.prices = {**_default_prices(), **cfg.prices}     # only the user's own edits are stored, so the app's price list can improve later
            return cfg
        except Exception:               # a damaged setting must never stop the app: fall back to the safe local default
            return AIConfig()

    @staticmethod
    def _dump(cfg: AIConfig) -> str:
        """Store only prices the user changed or added: the defaults come from the app, so a corrected default reaches everyone."""
        data = cfg.model_dump()
        data["prices"] = {k: v for k, v in data["prices"].items() if k not in DEFAULT_PRICES or v != DEFAULT_PRICES[k].model_dump()}
        return json.dumps(data)

    def _write(self, key: str, value: str) -> None:
        with self.db.tx() as c:
            c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def update(self, patch: AIConfigUpdate) -> AIConfig:
        cur = self.get()
        data = cur.model_dump()
        for field in ("grader_model", "fallback_model", "use_fallback", "conversation_model", "fallback_to_local", "enforce_budget", "prices"):
            value = getattr(patch, field)
            if value is not None:
                data[field] = value if field != "prices" else {k: v.model_dump() for k, v in value.items()}
        if patch.daily_budget_usd is not None:
            data["daily_budget_usd"] = patch.daily_budget_usd
        if patch.total_budget_usd is not None:
            data["total_budget_usd"] = patch.total_budget_usd
        if patch.clear_daily_budget:
            data["daily_budget_usd"] = None
        if patch.clear_total_budget:
            data["total_budget_usd"] = None
        if patch.acknowledge_cloud and not cur.cloud_consent_at:
            data["cloud_consent_at"] = utcnow()
        if patch.mode is not None:
            if patch.mode == "cloud":                       # switching TO the cloud needs consent and a key; switching back never does
                if not data.get("cloud_consent_at"):
                    raise AppError(422, "consent_required", "Please confirm that you understand your questions and answers will be sent to Ollama's servers.")
                if not self.api_key():
                    raise AppError(422, "key_required", "Add your Ollama cloud API key first (ollama.com/settings/keys).")
            data["mode"] = patch.mode
        try:
            cfg = AIConfig.model_validate(data)
        except ValueError as e:
            raise AppError(422, "invalid_ai_config", _first_error(e)) from e
        self._write(CONFIG_KEY, self._dump(cfg))
        return cfg

    # ------------------------------------------------------------ the API key (write-only from the outside)
    def api_key(self) -> Optional[str]:
        env = (os.environ.get("OLLAMA_API_KEY") or "").strip()
        if env:
            return env
        with self.db.read() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (SECRET_KEY,)).fetchone()
        return row[0] if row and row[0] else None

    def key_info(self) -> dict[str, Any]:
        env = (os.environ.get("OLLAMA_API_KEY") or "").strip()
        key = self.api_key()
        return {"set": bool(key), "source": "environment" if env else ("saved" if key else None), "hint": f"••••{key[-4:]}" if key and len(key) >= 12 else ("••••" if key else None)}

    def set_key(self, raw: str) -> None:
        self._write(SECRET_KEY, clean_key(raw))

    def clear_key(self) -> None:
        with self.db.tx() as c:
            c.execute("DELETE FROM settings WHERE key=?", (SECRET_KEY,))
        cfg = self.get()
        if cfg.mode == "cloud" and not self.api_key():      # no key left: never stay in a mode that cannot work
            self._write(CONFIG_KEY, self._dump(cfg.model_copy(update={"mode": "local"})))

    # ------------------------------------------------------------ last connection test (so the models list survives a restart)
    def last_test(self) -> Optional[dict[str, Any]]:
        with self.db.read() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (TEST_KEY,)).fetchone()
        try:
            return json.loads(row[0]) if row else None
        except ValueError:
            return None

    def save_test(self, result: dict[str, Any]) -> None:
        self._write(TEST_KEY, json.dumps(result))


def _first_error(e: ValueError) -> str:
    try:
        err = e.errors()[0]                              # type: ignore[attr-defined]
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "__root__")
        return f"{loc}: {err.get('msg', 'invalid value')}".replace("Value error, ", "") if loc else str(err.get("msg", "invalid value"))
    except Exception:
        return "The AI settings are not valid."
