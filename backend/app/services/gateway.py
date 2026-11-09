"""One place decides which engine answers each model request: the local Ollama model (default) or Ollama cloud models (opt-in).

Rules that protect privacy and credits:
  * LOCAL mode never touches the cloud. There is no automatic switch from local to cloud, ever.
  * CLOUD mode sends only the text of the interview (questions, answers, rubric) to the models. Voice stays on this computer.
  * Each task has a role: the GRADER grades answers, writes feedback and the report summary; the CONVERSATION model writes follow-up
    questions and cleans up voice transcripts. If the grader fails for a reason a different model could fix (timeout, outage, unknown model),
    the FALLBACK model is tried once. The conversation tasks are optional polish with a free alternative, so they are never retried.
    Problems that every model would hit (bad key, no credits, rate limit, budget used up) are NOT retried either,
    so a failure never turns into repeated paid calls.
  * An optional budget stops cloud calls before they are made once the daily or total limit is reached.
  * Optionally, if the cloud fails, the LOCAL model is used instead (never the other way round) and the result says so.
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any, Optional

from .ai_config import AIConfig, AIConfigStore
from .cloud import CloudClient
from .ollama import LLMError, OllamaClient
from .usage import UsageRecorder, local_midnight_utc

log = logging.getLogger("interviewer.gateway")

ROLE_BY_PURPOSE = {"evaluation": "grader", "summary": "grader", "repair": "conversation", "followup": "conversation",
                   "resume_parse": "grader", "resume_questions": "grader"}
NO_MODEL_FALLBACK = {"auth_failed", "auth_missing", "no_credits", "rate_limited", "budget_reached"}   # a different cloud model would hit the same wall
_ROUTE: ContextVar[Optional[dict[str, Any]]] = ContextVar("llm_route", default=None)


class LLMGateway:
    def __init__(self, local: OllamaClient, cloud: CloudClient, ai: AIConfigStore, usage: Optional[UsageRecorder] = None):
        self.local, self.cloud, self.ai, self.usage = local, cloud, ai, usage

    def __getattr__(self, name: str) -> Any:
        """Everything that is not about choosing an engine (version, models list, running models, speech helpers...) is the local client's."""
        if name.startswith("_") or name in {"local", "cloud", "ai", "usage"}:
            raise AttributeError(name)
        return getattr(self.local, name)

    # ------------------------------------------------------------ state
    def is_cloud(self) -> bool:
        return self.ai.get().mode == "cloud"

    def last_route(self) -> Optional[dict[str, Any]]:
        """Which engine and model produced the most recent reply on this thread (shown on the feedback screen)."""
        return _ROUTE.get()

    def warm(self, model: str) -> bool:
        return True if self.is_cloud() else self.local.warm(model)        # nothing to load for a cloud model

    # ------------------------------------------------------------ budget
    def budget_status(self, cfg: Optional[AIConfig] = None) -> dict[str, Any]:
        cfg = cfg or self.ai.get()
        today = self.usage.cloud_spend(local_midnight_utc()) if self.usage else 0.0
        total = self.usage.cloud_spend() if self.usage else 0.0
        def part(spent: float, cap: Optional[float]) -> dict[str, Any]:
            return {"spent_usd": spent, "limit_usd": cap, "percent": None if not cap else min(100, round(100 * spent / cap)), "reached": cap is not None and spent >= cap}
        return {"enforced": cfg.enforce_budget, "today": part(today, cfg.daily_budget_usd), "total": part(total, cfg.total_budget_usd)}

    def _check_budget(self, cfg: AIConfig) -> None:
        if not cfg.enforce_budget or not self.usage:
            return
        b = self.budget_status(cfg)
        if b["today"]["reached"]:
            raise LLMError("budget_reached", f"Your daily cloud budget is used up (${b['today']['spent_usd']:.4f} of ${cfg.daily_budget_usd:.2f}). "
                                             "Raise the limit in Settings → AI models, wait until tomorrow, or switch to the local model.")
        if b["total"]["reached"]:
            raise LLMError("budget_reached", f"Your total cloud budget is used up (${b['total']['spent_usd']:.4f} of ${cfg.total_budget_usd:.2f}). "
                                             "Raise the limit in Settings → AI models, or switch to the local model.")

    # ------------------------------------------------------------ the request
    def chat_json(self, messages: list[dict[str, str]], schema: dict[str, Any], model: Optional[str] = None, max_tokens: Optional[int] = None,
                  temperature: Optional[float] = None, purpose: str = "chat") -> str:
        cfg = self.ai.get()
        if cfg.mode != "cloud":
            _ROUTE.set({"provider": "local", "model": model or self.local.settings.llm_model, "fell_back_from": None})
            return self.local.chat_json(messages, schema, model=model, max_tokens=max_tokens, temperature=temperature, purpose=purpose)
        return self._cloud_chat(cfg, messages, schema, max_tokens, temperature, purpose)

    def _cloud_chat(self, cfg: AIConfig, messages, schema, max_tokens, temperature, purpose) -> str:
        role = ROLE_BY_PURPOSE.get(purpose, "grader")
        primary = cfg.conversation_model if role == "conversation" else cfg.grader_model
        # Backup models rescue ESSENTIAL work (grading, the report summary). Follow-up polish and voice-transcript cleanup are optional:
        # the caller has a free alternative (the grader's own draft / the raw transcript), so they get one attempt and no paid second try.
        essential = role == "grader"
        candidates = [primary] + ([cfg.fallback_model] if essential and cfg.use_fallback and cfg.fallback_model and cfg.fallback_model != primary else [])
        last: Optional[LLMError] = None
        for i, model in enumerate(candidates):
            try:
                self._check_budget(cfg)
                text = self.cloud.chat_json(messages, schema, model=model, max_tokens=max_tokens, temperature=temperature, purpose=purpose)
                _ROUTE.set({"provider": "cloud", "model": model, "fell_back_from": primary if i else None})
                if i:
                    log.warning("cloud model %s failed (%s); answered by %s", primary, last.code if last else "?", model)
                return text
            except LLMError as e:
                last = e
                if e.code in NO_MODEL_FALLBACK:
                    break
        assert last is not None
        if cfg.fallback_to_local and essential:
            local_model = self.local.settings.llm_model
            try:
                text = self.local.chat_json(messages, schema, model=None, max_tokens=max_tokens, temperature=temperature, purpose=purpose)
            except LLMError as local_err:
                raise LLMError(last.code, f"{last.message} The local model could not help either: {local_err.message}") from local_err
            _ROUTE.set({"provider": "local", "model": local_model, "fell_back_from": primary, "reason": last.message})
            return text
        raise last
