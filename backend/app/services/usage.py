"""A local log of what each model call cost: tokens and time. Numbers only - prompts and answers are never stored.

Ollama returns these figures with every reply (prompt_eval_count, eval_count, load_duration, ...) but keeps no history,
so this is where you can look at them over time (Settings -> Model usage).
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional

from ..db import Database
from .pricing import ModelPrice, cost_usd, find_price

log = logging.getLogger("interviewer.usage")

KEEP_ROWS = 2000          # older rows are pruned
COLD_LOAD_MS = 1000       # a model load slower than this is what makes the computer stall


def from_ollama(reply: dict[str, Any], model: str, purpose: str, provider: str = "local") -> dict[str, Any]:
    """The metrics block of an Ollama reply (all durations are nanoseconds) -> our record (milliseconds)."""
    ms = lambda key: int(round((reply.get(key) or 0) / 1e6))  # noqa: E731
    return {"model": model, "purpose": purpose, "provider": provider, "prompt_tokens": reply.get("prompt_eval_count"), "output_tokens": reply.get("eval_count"),
            "load_ms": ms("load_duration"), "prompt_ms": ms("prompt_eval_duration"), "output_ms": ms("eval_duration"), "total_ms": ms("total_duration")}


_CTX: ContextVar[Optional[dict[str, Any]]] = ContextVar("usage_context", default=None)


@contextmanager
def usage_context(interview_id: Optional[int], label: Optional[str] = None) -> Iterator[None]:
    """Everything recorded inside this block is attributed to that interview (and e.g. "Q2")."""
    token = _CTX.set({"interview_id": interview_id, "label": label})
    try:
        yield
    finally:
        _CTX.reset(token)


def local_midnight_utc() -> str:
    """Start of the user's current day, as the UTC ISO text used in created_at (so 'today' follows the local clock, not UTC)."""
    start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc).isoformat(timespec="seconds")


class UsageRecorder:
    def __init__(self, db: Database, prices: Optional[Callable[[], dict[str, ModelPrice]]] = None):
        self.db = db
        self.prices = prices or (lambda: {})
        self._since_prune = 0

    def _cost(self, u: dict[str, Any], now: datetime) -> Optional[float]:
        """Cloud calls only: an estimated dollar cost from the configured price (None when the model has no price). Local calls are free."""
        if u.get("provider", "local") != "cloud":
            return None
        if u.get("cost_usd") is not None:
            return float(u["cost_usd"])
        return cost_usd(find_price(u["model"], self.prices()), u.get("prompt_tokens"), u.get("output_tokens"), now)

    def record(self, u: dict[str, Any]) -> None:
        """Never raises: logging usage must not be able to break an interview."""
        ctx = _CTX.get() or {}
        try:
            now = datetime.now(timezone.utc)
            with self.db.tx() as c:
                c.execute("""INSERT INTO llm_usage(created_at, model, purpose, prompt_tokens, output_tokens, load_ms, prompt_ms, output_ms, total_ms, detail,
                                                   interview_id, label, provider, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (now.isoformat(timespec="seconds"), u["model"], u["purpose"], u.get("prompt_tokens"), u.get("output_tokens"), int(u.get("load_ms") or 0),
                           int(u.get("prompt_ms") or 0), int(u.get("output_ms") or 0), int(u.get("total_ms") or 0), (u.get("detail") or None),
                           u.get("interview_id", ctx.get("interview_id")), u.get("label", ctx.get("label")), u.get("provider", "local"), self._cost(u, now)))
                self._since_prune += 1
                if self._since_prune >= 100:
                    self._since_prune = 0
                    c.execute("DELETE FROM llm_usage WHERE id <= (SELECT MAX(id) FROM llm_usage) - ?", (KEEP_ROWS,))
        except Exception:
            log.exception("could not record model usage")

    # ------------------------------------------------------------ filters shared by the readers
    @staticmethod
    def _where(range_: str, provider: Optional[str], alias: str = "") -> tuple[str, list[Any]]:
        col = f"{alias}." if alias else ""
        clauses: list[str] = []
        args: list[Any] = []
        if range_ == "today":
            clauses.append(f"{col}created_at >= ?")
            args.append(local_midnight_utc())
        if provider in ("local", "cloud"):
            clauses.append(f"{col}provider = ?")
            args.append(provider)
        return (" WHERE " + " AND ".join(clauses)) if clauses else "", args

    def summary(self, range_: str = "all", provider: Optional[str] = None) -> list[dict[str, Any]]:
        """One row per (provider, model, task): calls, tokens, cost, how long (average / fastest / slowest), where the time goes, how fast."""
        where, args = self._where(range_, provider)
        with self.db.read() as c:
            rows = c.execute(f"""
                SELECT provider, model, purpose, COUNT(*) AS calls, SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens, SUM(COALESCE(output_tokens,0)) AS output_tokens,
                       SUM(total_ms) AS total_ms, MIN(total_ms) AS min_ms, MAX(total_ms) AS max_ms,
                       SUM(load_ms) AS load_ms, SUM(prompt_ms) AS prompt_ms, SUM(output_ms) AS output_ms,
                       SUM(CASE WHEN output_ms > 0 THEN output_tokens ELSE 0 END) AS timed_tokens,
                       SUM(CASE WHEN output_ms > 0 THEN output_ms ELSE 0 END) AS timed_ms, SUM(CASE WHEN load_ms >= ? THEN 1 ELSE 0 END) AS loads,
                       SUM(COALESCE(cost_usd, 0)) AS cost, SUM(CASE WHEN provider = 'cloud' AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
                       MAX(created_at) AS last_at
                FROM llm_usage{where} GROUP BY provider, model, purpose ORDER BY provider DESC, model, purpose""", (COLD_LOAD_MS, *args)).fetchall()
        sec = lambda ms, n=1: round(ms / n / 1000, 1)  # noqa: E731
        return [{"provider": r["provider"], "model": r["model"], "purpose": r["purpose"], "calls": r["calls"], "prompt_tokens": r["prompt_tokens"], "output_tokens": r["output_tokens"],
                 "avg_seconds": sec(r["total_ms"], r["calls"]), "total_seconds": sec(r["total_ms"]), "fastest_seconds": sec(r["min_ms"]), "slowest_seconds": sec(r["max_ms"]),
                 "avg_load_seconds": sec(r["load_ms"], r["calls"]), "avg_read_seconds": sec(r["prompt_ms"], r["calls"]), "avg_write_seconds": sec(r["output_ms"], r["calls"]),
                 "tokens_per_second": round(r["timed_tokens"] / (r["timed_ms"] / 1000), 1) if r["timed_ms"] else None,
                 "model_loads": r["loads"], "cost_usd": round(r["cost"], 6) if r["provider"] == "cloud" else None, "unpriced_calls": r["unpriced"], "last_at": r["last_at"]} for r in rows]

    def recent(self, limit: int = 30, range_: str = "all", provider: Optional[str] = None) -> list[dict[str, Any]]:
        where, args = self._where(range_, provider, "u")
        with self.db.read() as c:
            rows = c.execute(f"""SELECT u.*, i.title AS interview_title, i.status AS interview_status,
                                        (SELECT COUNT(*) FROM reports r WHERE r.interview_id = u.interview_id) AS has_report
                                 FROM llm_usage u LEFT JOIN interviews i ON i.id = u.interview_id{where} ORDER BY u.id DESC LIMIT ?""",
                             (*args, max(1, min(limit, 200)))).fetchall()
        return [{"id": r["id"], "at": r["created_at"], "provider": r["provider"], "model": r["model"], "purpose": r["purpose"], "prompt_tokens": r["prompt_tokens"],
                 "output_tokens": r["output_tokens"], "load_seconds": round(r["load_ms"] / 1000, 1), "read_seconds": round(r["prompt_ms"] / 1000, 1),
                 "write_seconds": round(r["output_ms"] / 1000, 1), "seconds": round(r["total_ms"] / 1000, 1),
                 "tokens_per_second": round(r["output_tokens"] / (r["output_ms"] / 1000), 1) if r["output_tokens"] and r["output_ms"] else None,
                 "cost_usd": r["cost_usd"], "detail": r["detail"], "interview_id": r["interview_id"], "interview_title": r["interview_title"],
                 "interview_status": r["interview_status"], "has_report": bool(r["has_report"]), "label": r["label"]} for r in rows]

    def totals(self) -> dict[str, Any]:
        start = local_midnight_utc()
        q = """SELECT COUNT(*) n, SUM(COALESCE(prompt_tokens,0)) p, SUM(COALESCE(output_tokens,0)) o, SUM(total_ms) t, SUM(COALESCE(cost_usd,0)) cost,
                      SUM(CASE WHEN provider='cloud' THEN 1 ELSE 0 END) cloud_calls,
                      SUM(CASE WHEN provider='cloud' AND cost_usd IS NULL THEN 1 ELSE 0 END) unpriced FROM llm_usage"""
        with self.db.read() as c:
            all_ = c.execute(q).fetchone()
            day = c.execute(q + " WHERE created_at >= ?", (start,)).fetchone()
        pack = lambda r: {"calls": r["n"] or 0, "prompt_tokens": r["p"] or 0, "output_tokens": r["o"] or 0, "seconds": round((r["t"] or 0) / 1000, 1),  # noqa: E731
                          "cost_usd": round(r["cost"] or 0, 6), "cloud_calls": r["cloud_calls"] or 0, "unpriced_calls": r["unpriced"] or 0}
        return {"all_time": pack(all_), "today": pack(day)}

    # ------------------------------------------------------------ spending (the budget guard reads these)
    def cloud_spend(self, since: Optional[str] = None) -> float:
        with self.db.read() as c:
            row = c.execute("SELECT SUM(COALESCE(cost_usd,0)) FROM llm_usage WHERE provider='cloud'" + (" AND created_at >= ?" if since else ""),
                            (since,) if since else ()).fetchone()
        return round(row[0] or 0.0, 6)

    def for_interview(self, interview_id: int) -> dict[str, Any]:
        """What the AI cost for one interview (shown on its report)."""
        with self.db.read() as c:
            rows = c.execute("""SELECT provider, COUNT(*) calls, SUM(COALESCE(prompt_tokens,0)) p, SUM(COALESCE(output_tokens,0)) o, SUM(total_ms) t,
                                       SUM(COALESCE(cost_usd,0)) cost, SUM(CASE WHEN provider='cloud' AND cost_usd IS NULL THEN 1 ELSE 0 END) unpriced
                                FROM llm_usage WHERE interview_id = ? GROUP BY provider""", (interview_id,)).fetchall()
        by = {r["provider"]: {"calls": r["calls"], "prompt_tokens": r["p"], "output_tokens": r["o"], "seconds": round(r["t"] / 1000, 1),
                              "cost_usd": round(r["cost"], 6) if r["provider"] == "cloud" else None, "unpriced_calls": r["unpriced"]} for r in rows}
        return {"calls": sum(v["calls"] for v in by.values()), "prompt_tokens": sum(v["prompt_tokens"] for v in by.values()), "output_tokens": sum(v["output_tokens"] for v in by.values()),
                "seconds": round(sum(v["seconds"] for v in by.values()), 1), "cost_usd": by.get("cloud", {}).get("cost_usd"), "by_provider": by}

    def clear(self) -> int:
        with self.db.tx() as c:
            return c.execute("DELETE FROM llm_usage").rowcount


def loaded_models(running: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`ollama ps` as data: what is in memory right now and when it will be unloaded."""
    out = []
    now = datetime.now(timezone.utc)
    for m in running:
        size, vram = m.get("size") or 0, m.get("size_vram") or 0
        left: Optional[int] = None
        try:
            left = max(0, int((datetime.fromisoformat(str(m["expires_at"])) - now).total_seconds()))
        except (KeyError, ValueError, TypeError):
            pass
        out.append({"model": m.get("name"), "size_gb": round(size / 2**30, 1), "gpu_percent": round(100 * vram / size) if size else None,
                    "context": m.get("context_length"), "unloads_in_seconds": left})
    return out
