"""/api/stats feeds the Home dashboard from stored reports (no model involved)."""
import json
from datetime import date, datetime, timedelta, timezone

from app.services.stats import _streak, build_stats


def seed_run(db, *, days_ago: int, score, topics=None, answered=3, scored=3, status="completed", title=None):
    created = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat(timespec="seconds")
    with db.tx() as c:
        iid = c.execute("""INSERT INTO interviews(title, interview_type, status, phase, config_json, created_at, completed_at, updated_at)
                           VALUES (?, 'technical', ?, 'done', '{}', ?, ?, ?)""",
                        (title or f"Run {days_ago}d ago", status, created, created, created)).lastrowid
        if score is not None or topics is not None:
            report = {"summary": {"answered": answered, "scored": scored, "average_score": score},
                      "topics": [{"topic": t, "average_score": s, "scored": n} for t, s, n in (topics or [])]}
            c.execute("INSERT INTO reports(interview_id, data_json, narrative_status, created_at, updated_at) VALUES (?,?,?,?,?)",
                      (iid, json.dumps(report), "ready", created, created))
    return iid


def test_empty_database_gives_an_empty_overview(client):
    s = client.get("/api/stats").json()
    assert s["interviews"] == 0 and s["average_score"] is None and s["trend"] == [] and s["topics"] == [] and s["streak_days"] == 0
    assert s["delta"] is None and s["best_score"] is None


def test_overview_numbers(container, client):
    db = container.db
    seed_run(db, days_ago=5, score=5.0, topics=[("SQL", 4.0, 2), ("Spark", 6.0, 1)])
    seed_run(db, days_ago=2, score=7.0, topics=[("SQL", 7.0, 1), ("Kafka", 8.0, 2)])
    seed_run(db, days_ago=0, score=8.0, topics=[("SQL", 9.0, 3)], answered=2, scored=2)
    seed_run(db, days_ago=0, score=None, status="ended", answered=0, scored=0)       # started but never scored
    s = client.get("/api/stats").json()
    assert s["interviews"] == 4 and s["completed"] == 3 and s["questions_answered"] == 8
    assert s["best_score"] == 8.0
    assert s["average_score"] == round((5 * 3 + 7 * 3 + 8 * 2) / 8, 1)               # weighted by scored questions
    assert [t["score"] for t in s["trend"]] == [5.0, 7.0, 8.0]
    assert s["delta"] == round(8.0 - (5.0 + 7.0) / 2, 1)                             # latest run vs the earlier ones
    sql = next(t for t in s["topics"] if t["topic"] == "SQL")
    assert sql["average_score"] == round((4 * 2 + 7 * 1 + 9 * 3) / 6, 1) and sql["questions"] == 6
    assert s["topics"][0]["average_score"] <= s["topics"][-1]["average_score"]        # weakest topic first
    assert s["this_week"] == 4


def test_delta_compares_three_against_three_with_enough_history(container, client):
    for i, sc in enumerate([4, 4, 4, 7, 7, 7]):
        seed_run(container.db, days_ago=10 - i, score=float(sc))
    assert client.get("/api/stats").json()["delta"] == 3.0


def test_streak_counts_consecutive_days_and_survives_an_empty_today():
    today = date(2026, 3, 10)
    assert _streak({today, today - timedelta(days=1), today - timedelta(days=2)}, today) == 3
    assert _streak({today - timedelta(days=1), today - timedelta(days=2)}, today) == 2     # nothing yet today: streak is not lost
    assert _streak({today - timedelta(days=2)}, today) == 0
    assert _streak({today, today - timedelta(days=2)}, today) == 1                         # a gap ends it


def test_trend_keeps_only_the_latest_twelve(container):
    for i in range(15):
        seed_run(container.db, days_ago=20 - i, score=float(i % 10))
    assert len(build_stats(container.db)["trend"]) == 12


def test_questions_without_a_topic_are_flagged_so_the_dashboard_does_not_treat_them_as_a_topic(container, client):
    seed_run(container.db, days_ago=0, score=4.9, topics=[("Uncategorized", 4.9, 4), ("SQL", 7.0, 2)])
    by_name = {t["topic"]: t for t in client.get("/api/stats").json()["topics"]}
    assert by_name["Uncategorized"]["untagged"] is True and by_name["SQL"]["untagged"] is False
