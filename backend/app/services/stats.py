"""Progress overview for the Home dashboard, computed only from the locally stored interviews and reports."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Any, Optional

from ..db import Database
from .reports import UNCATEGORIZED

TREND_POINTS = 12
TOPIC_WINDOW = 10      # topics are summarised over the most recent scored interviews
MAX_TOPICS = 6


def _local_date(iso: str) -> Optional[date]:
    try:
        return datetime.fromisoformat(iso).astimezone().date()
    except (TypeError, ValueError):
        return None


def _streak(days: set[date], today: date) -> int:
    """Consecutive days with at least one interview, counting back from today (or yesterday if nothing yet today)."""
    cur = today if today in days else today - timedelta(days=1)
    n = 0
    while cur in days:
        n += 1
        cur -= timedelta(days=1)
    return n


def build_stats(db: Database, today: Optional[date] = None) -> dict[str, Any]:
    today = today or datetime.now().astimezone().date()
    with db.read() as c:
        rows = c.execute("""SELECT i.id, i.title, i.status, i.created_at, i.completed_at, r.data_json
                            FROM interviews i LEFT JOIN reports r ON r.interview_id = i.id
                            ORDER BY i.created_at ASC, i.id ASC""").fetchall()

    days: set[date] = set()
    scored_runs: list[dict[str, Any]] = []
    answered = 0
    for r in rows:
        d = _local_date(r["created_at"])
        if d:
            days.add(d)
        if not r["data_json"]:
            continue
        rep = json.loads(r["data_json"])
        s = rep["summary"]
        answered += s.get("answered", 0)
        if s.get("average_score") is not None and s.get("scored"):
            scored_runs.append({"id": r["id"], "title": r["title"], "date": r["completed_at"] or r["created_at"],
                                "score": s["average_score"], "scored": s["scored"], "topics": rep.get("topics", [])})

    trend = [{"id": x["id"], "title": x["title"], "date": x["date"], "score": x["score"]} for x in scored_runs[-TREND_POINTS:]]

    # question-weighted overall average and the change between the latest runs and the ones before them
    total_scored = sum(x["scored"] for x in scored_runs)
    average = round(sum(x["score"] * x["scored"] for x in scored_runs) / total_scored, 1) if total_scored else None
    delta = None
    n = len(scored_runs)
    if n >= 2:
        # four or more runs: the latest three against the three before them; fewer: the latest run against all earlier ones
        latest, before = (scored_runs[-3:], scored_runs[:-3][-3:]) if n >= 4 else (scored_runs[-1:], scored_runs[:-1])
        delta = round(sum(x["score"] for x in latest) / len(latest) - sum(x["score"] for x in before) / len(before), 1)

    agg: dict[str, list[float]] = {}
    for run in scored_runs[-TOPIC_WINDOW:]:
        for t in run["topics"]:
            if t.get("average_score") is not None and t.get("scored"):
                acc = agg.setdefault(t["topic"], [0.0, 0])
                acc[0] += t["average_score"] * t["scored"]
                acc[1] += t["scored"]
    # "Uncategorized" is only the label reports use for questions that have NO topic; the dashboard must not treat it as a real topic
    topics = sorted(({"topic": k, "average_score": round(v[0] / v[1], 1), "questions": v[1], "untagged": k == UNCATEGORIZED} for k, v in agg.items()),
                    key=lambda t: (t["average_score"], t["topic"]))[:MAX_TOPICS]

    week_start = today - timedelta(days=6)
    return {
        "interviews": len(rows),
        "completed": sum(1 for r in rows if r["status"] == "completed"),
        "this_week": sum(1 for r in rows if (d := _local_date(r["created_at"])) and d >= week_start),
        "questions_answered": answered,
        "average_score": average,
        "best_score": max((x["score"] for x in scored_runs), default=None),
        "delta": delta,
        "streak_days": _streak(days, today),
        "trend": trend,
        "topics": topics,
    }
