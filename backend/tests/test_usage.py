"""Model usage log: tokens and time per model call, numbers only (Settings -> Model usage)."""
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.db import SCHEMA_V4 as SCHEMA, SCHEMA_VERSION, USAGE_SCHEMA, USAGE_V3_ALTERS, Database, _split_statements   # v4 = the schema before resumes
from app.services.usage import UsageRecorder, from_ollama, loaded_models, usage_context
from conftest import act, add_questions, answer, make_client_for, start_interview, state

MODEL = "qwen3.5:4b"


def rows(container):
    return container.usage.recent(100)


# ---------------------------------------------------------------- units
def test_ollama_reply_is_converted_from_nanoseconds_to_milliseconds():
    u = from_ollama({"prompt_eval_count": 21, "eval_count": 22, "load_duration": 5_660_000_000, "prompt_eval_duration": 200_000_000,
                     "eval_duration": 1_000_000_000, "total_duration": 6_930_000_000}, MODEL, "evaluation")
    assert u == {"model": MODEL, "purpose": "evaluation", "provider": "local", "prompt_tokens": 21, "output_tokens": 22, "load_ms": 5660, "prompt_ms": 200,
                 "output_ms": 1000, "total_ms": 6930}
    assert from_ollama({}, MODEL, "x")["total_ms"] == 0                                    # missing fields are zero, not an error


def test_summary_groups_by_model_and_task_with_speed_and_cold_loads(container):
    r = container.usage
    r.record({"model": MODEL, "purpose": "evaluation", "prompt_tokens": 800, "output_tokens": 400, "output_ms": 20_000, "total_ms": 21_000})
    r.record({"model": MODEL, "purpose": "evaluation", "prompt_tokens": 1000, "output_tokens": 600, "output_ms": 30_000, "load_ms": 15_000, "total_ms": 47_000})
    r.record({"model": "phonon", "purpose": "speech", "total_ms": 2_000, "detail": "60 characters, 3.0 s of audio"})
    s = {(x["model"], x["purpose"]): x for x in r.summary()}
    ev = s[(MODEL, "evaluation")]
    assert ev["calls"] == 2 and ev["prompt_tokens"] == 1800 and ev["output_tokens"] == 1000
    assert ev["avg_seconds"] == 34.0 and ev["total_seconds"] == 68.0
    assert ev["tokens_per_second"] == 20.0                                                 # 1000 tokens over 50 s of generating
    assert ev["model_loads"] == 1                                                          # only the 15 s one counts as a cold load
    sp = s[("phonon", "speech")]
    assert sp["calls"] == 1 and sp["output_tokens"] == 0 and sp["tokens_per_second"] is None


def test_recent_is_newest_first_and_limited(container):
    for i in range(5):
        container.usage.record({"model": MODEL, "purpose": "evaluation", "total_ms": 1000 * (i + 1)})
    got = container.usage.recent(3)
    assert [g["seconds"] for g in got] == [5.0, 4.0, 3.0]
    assert len(container.usage.recent(9999)) == 5


def test_totals_split_today_from_all_time(container):
    container.usage.record({"model": MODEL, "purpose": "evaluation", "prompt_tokens": 100, "output_tokens": 50, "total_ms": 3000})
    with container.db.tx() as c:                                                           # an old call from last week
        c.execute("INSERT INTO llm_usage(created_at, model, purpose, prompt_tokens, output_tokens, total_ms) VALUES (?,?,?,?,?,?)",
                  ((datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds"), MODEL, "evaluation", 1000, 500, 10000))
    t = container.usage.totals()
    assert t["today"] == {"calls": 1, "prompt_tokens": 100, "output_tokens": 50, "seconds": 3.0, "cost_usd": 0.0, "cloud_calls": 0, "unpriced_calls": 0}
    assert t["all_time"]["calls"] == 2 and t["all_time"]["output_tokens"] == 550


def test_log_is_pruned_and_can_be_cleared(container):
    from app.services import usage as mod

    with container.db.tx() as c:
        c.executemany("INSERT INTO llm_usage(created_at, model, purpose) VALUES ('2026-01-01T00:00:00', 'm', 'evaluation')", [() for _ in range(mod.KEEP_ROWS + 50)])
    container.usage._since_prune = 99
    container.usage.record({"model": MODEL, "purpose": "evaluation"})                      # 100th record triggers the prune
    with container.db.read() as c:
        assert c.execute("SELECT COUNT(*) FROM llm_usage").fetchone()[0] <= mod.KEEP_ROWS + 1
    assert container.usage.clear() > 0 and container.usage.recent() == []


def test_recording_can_never_break_the_caller(container, monkeypatch):
    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(container.db, "tx", boom)
    container.usage.record({"model": MODEL, "purpose": "evaluation"})                      # must not raise


def test_loaded_models_describes_ollama_ps():
    soon = (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat()
    got = loaded_models([{"name": MODEL, "size": 4_400_000_000, "size_vram": 4_400_000_000, "context_length": 6144, "expires_at": soon}, {"name": "x"}])
    assert got[0]["gpu_percent"] == 100 and got[0]["context"] == 6144 and got[0]["size_gb"] == 4.1 and 200 < got[0]["unloads_in_seconds"] <= 240
    assert got[1]["size_gb"] == 0 and got[1]["gpu_percent"] is None and got[1]["unloads_in_seconds"] is None


# ---------------------------------------------------------------- recorded by the real code paths
def test_grading_an_answer_records_tokens_and_time(client, container, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st, "A typed answer")
    ev = [r for r in rows(container) if r["purpose"] == "evaluation"]
    assert len(ev) == 1 and ev[0]["model"] == MODEL
    assert (ev[0]["prompt_tokens"], ev[0]["output_tokens"]) == (800, 400) and ev[0]["tokens_per_second"] == 20.0 and ev[0]["seconds"] == 20.3


def test_voice_answers_record_the_repair_step_separately(client, container, set_id, fake):
    from conftest import good_eval

    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    fake.chat_replies = [{"text": "MySQL is relational.", "unclear": []}, good_eval()]
    answer(client, st, "My SQL is relational", source="voice")
    assert sorted(r["purpose"] for r in rows(container)) == ["evaluation", "repair"]


def test_the_report_summary_is_recorded_when_an_interview_finishes(client, container, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    st = answer(client, st).json()
    act(client, state(client, st["id"]), "continue")
    assert "summary" in {r["purpose"] for r in rows(container)}


def test_speech_records_time_and_audio_length_but_cached_replays_do_not(client, container):
    body = {"text": "Hello there. How are you?", "voice": "Harper"}
    client.post("/api/speech/synthesize", json=body)
    client.post("/api/speech/synthesize", json=body)                                       # served from the disk cache: no model work
    sp = [r for r in rows(container) if r["purpose"] == "speech"]
    assert len(sp) == 1 and sp[0]["model"] == "phonon" and sp[0]["prompt_tokens"] is None
    assert "characters" in sp[0]["detail"] and "s of audio" in sp[0]["detail"]


def stopwatch(container, start, end):
    """The client's own clock: read once before the load request and once after (never the global time module)."""
    ticks = iter([start, end])
    container.ollama._clock = lambda: next(ticks)


def test_a_real_model_load_is_timed_by_the_app_because_ollama_reports_none(client, container, fake):
    """Ollama's reply to a load-only request has no timing fields (verified), so the app uses its own stopwatch."""
    stopwatch(container, 100.0, 104.2)                               # the load took 4.2 s
    client.post("/api/llm/warm")
    warm = [r for r in rows(container) if r["purpose"] == "warm"]
    assert len(warm) == 1 and warm[0]["load_seconds"] == 4.2 and warm[0]["seconds"] == 4.2 and warm[0]["model"] == MODEL


def test_a_load_time_reported_by_ollama_wins_over_the_stopwatch(client, container, fake):
    fake.load_ns = 5_000_000_000
    client.post("/api/llm/warm")
    assert [r["load_seconds"] for r in rows(container) if r["purpose"] == "warm"] == [5.0]


def test_a_timer_refresh_of_an_already_loaded_model_is_not_recorded(client, container, fake):
    fake.loaded = [MODEL]
    stopwatch(container, 100.0, 109.0)                                # even a slow-looking refresh
    client.post("/api/llm/warm")
    assert [r for r in rows(container) if r["purpose"] == "warm"] == []


def test_a_fast_cache_hit_load_under_a_third_of_a_second_is_not_worth_a_row(client, container, fake):
    stopwatch(container, 100.0, 100.1)
    client.post("/api/llm/warm")
    assert [r for r in rows(container) if r["purpose"] == "warm"] == []


def test_no_prompt_or_answer_text_is_ever_stored(client, container, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st, "SECRET-ANSWER-TEXT-12345")
    client.post("/api/speech/synthesize", json={"text": "SECRET-SPOKEN-QUESTION-67890", "voice": "Harper"})
    with container.db.read() as c:
        dump = " ".join(str(tuple(r)) for r in c.execute("SELECT * FROM llm_usage"))
    assert "SECRET" not in dump and dump                                                   # rows exist, none contain text


# ---------------------------------------------------------------- API
def test_usage_endpoint_and_clearing(client, container, set_id, fake):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st)
    fake.loaded = [MODEL]
    d = client.get("/api/usage").json()
    assert set(d) == {"range", "provider", "mode", "loaded", "summary", "recent", "totals", "budget", "prices_note"} and d["range"] == "all" and d["mode"] == "local"
    assert d["loaded"][0]["model"] == MODEL and d["summary"][0]["purpose"] == "evaluation" and d["totals"]["all_time"]["calls"] >= 1
    assert client.get("/api/usage?limit=1").json()["recent"].__len__() == 1
    assert client.delete("/api/usage").json()["deleted"] >= 1
    assert client.get("/api/usage").json()["recent"] == []


# ---------------------------------------------------------------- upgrading a database created before this feature
def test_an_existing_v1_database_is_upgraded_in_place_without_losing_anything(tmp_path):
    path = tmp_path / "old.sqlite3"
    raw = sqlite3.connect(path)
    for stmt in _split_statements(SCHEMA.replace(USAGE_SCHEMA, "")):                      # exactly what a pre-feature install has
        raw.execute(stmt)
    raw.execute("INSERT INTO question_sets(name, created_at, updated_at) VALUES ('My old set', '2026-01-01', '2026-01-01')")
    raw.execute("PRAGMA user_version=1")
    raw.commit(); raw.close()
    assert "llm_usage" not in [r[0] for r in sqlite3.connect(path).execute("SELECT name FROM sqlite_master")]
    db = Database(path)
    with db.read() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert c.execute("SELECT name FROM question_sets WHERE name='My old set'").fetchone() is not None
    UsageRecorder(db).record({"model": MODEL, "purpose": "evaluation", "total_ms": 1000})
    assert len(UsageRecorder(db).recent()) == 1
    Database(path)                                                                          # opening it again is a no-op


OLD_V2_USAGE = """
CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, prompt_tokens INTEGER, output_tokens INTEGER,
    load_ms INTEGER NOT NULL DEFAULT 0, prompt_ms INTEGER NOT NULL DEFAULT 0, output_ms INTEGER NOT NULL DEFAULT 0, total_ms INTEGER NOT NULL DEFAULT 0, detail TEXT
);
CREATE INDEX idx_usage_created ON llm_usage(created_at);
"""


def test_a_v2_database_gets_the_interview_columns_and_keeps_its_usage_rows(tmp_path):
    path = tmp_path / "v2.sqlite3"
    raw = sqlite3.connect(path)
    for stmt in _split_statements(SCHEMA.replace(USAGE_SCHEMA, "") + OLD_V2_USAGE):
        raw.execute(stmt)
    raw.execute("INSERT INTO llm_usage(created_at, model, purpose, total_ms) VALUES ('2026-10-30T10:00:00+00:00', 'qwen3.5:4b', 'evaluation', 21000)")
    raw.execute("PRAGMA user_version=2")
    raw.commit(); raw.close()
    db = Database(path)
    with db.read() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert {r[1] for r in c.execute("PRAGMA table_info(llm_usage)")} >= {"interview_id", "label", "provider", "cost_usd"}
    rec = UsageRecorder(db)
    old = rec.recent()[0]
    assert old["seconds"] == 21.0 and old["interview_id"] is None and old["label"] is None      # the old row survived, unattributed
    rec.record({"model": "qwen3.5:4b", "purpose": "evaluation", "interview_id": 7, "label": "Q2"})
    assert rec.recent()[0]["interview_id"] == 7


# ---------------------------------------------------------------- "for what": which interview and question a call was for
def test_grading_is_attributed_to_the_interview_and_question(client, container, set_id):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id, max_followups=0, title="Practice run")
    answer(client, st, "My answer")
    ev = [r for r in rows(container) if r["purpose"] == "evaluation"][0]
    assert ev["interview_id"] == st["id"] and ev["label"] == "Q1" and ev["interview_title"] == "Practice run"


def test_follow_up_answers_and_summaries_are_labelled(client, container, set_id, fake):
    from conftest import good_eval

    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=1)
    fake.chat_replies = [good_eval(correctness=4, followup="Which key would you merge on, and why that one?", missing=["Keys"])]
    st = answer(client, st, "weak").json()
    st = act(client, state(client, st["id"]), "continue").json()                            # moves to the follow-up
    answer(client, state(client, st["id"]), "I would merge on the business key")
    labels = [r["label"] for r in rows(container) if r["purpose"] == "evaluation"]
    assert "Q1" in labels and "Q1 follow-up" in labels
    st = state(client, st["id"])
    act(client, st, "continue")
    assert "Report summary" in {r["label"] for r in rows(container)}


def test_calls_outside_an_interview_have_no_attribution(client, container):
    client.post("/api/speech/synthesize", json={"text": "Hello there", "voice": "Harper"})
    sp = [r for r in rows(container) if r["purpose"] == "speech"][0]
    assert sp["interview_id"] is None and sp["label"] is None


def test_deleting_an_interview_keeps_its_usage_rows_without_a_title(client, container, set_id):
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    answer(client, st, "x")
    client.delete(f"/api/interviews/{st['id']}")
    ev = [r for r in rows(container) if r["purpose"] == "evaluation"][0]
    assert ev["interview_title"] is None and ev["interview_id"] == st["id"]


def test_context_is_scoped_to_its_block(container):
    with usage_context(5, "Q1"):
        container.usage.record({"model": MODEL, "purpose": "evaluation"})
    container.usage.record({"model": MODEL, "purpose": "evaluation"})
    got = rows(container)
    assert (got[0]["interview_id"], got[1]["interview_id"]) == (None, 5)


# ---------------------------------------------------------------- ranges and detail
def test_summary_reports_fastest_slowest_and_where_the_time_goes(container):
    r = container.usage
    r.record({"model": MODEL, "purpose": "evaluation", "prompt_tokens": 1000, "output_tokens": 400, "load_ms": 4000, "prompt_ms": 1000, "output_ms": 20000, "total_ms": 25000})
    r.record({"model": MODEL, "purpose": "evaluation", "prompt_tokens": 1000, "output_tokens": 400, "load_ms": 0, "prompt_ms": 500, "output_ms": 15000, "total_ms": 15500})
    s = r.summary()[0]
    assert (s["fastest_seconds"], s["slowest_seconds"], s["avg_seconds"]) == (15.5, 25.0, 20.2)
    assert (s["avg_load_seconds"], s["avg_read_seconds"], s["avg_write_seconds"]) == (2.0, 0.8, 17.5)


def test_today_range_filters_the_summary_and_the_list(container, client):
    old = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(timespec="seconds")
    with container.db.tx() as c:
        c.execute("INSERT INTO llm_usage(created_at, model, purpose, total_ms) VALUES (?, ?, 'evaluation', 9000)", (old, MODEL))
    container.usage.record({"model": MODEL, "purpose": "evaluation", "total_ms": 1000})
    assert container.usage.summary("all")[0]["calls"] == 2 and container.usage.summary("today")[0]["calls"] == 1
    assert len(container.usage.recent(range_="today")) == 1 and len(container.usage.recent()) == 2
    d = client.get("/api/usage?range=today").json()
    assert d["range"] == "today" and d["summary"][0]["calls"] == 1 and client.get("/api/usage?range=bogus").json()["range"] == "all"


@pytest.mark.skipif(not hasattr(time, "tzset"), reason="needs POSIX tzset")
def test_today_follows_the_local_clock_not_utc(container, monkeypatch):
    """In India (UTC+5:30) 02:00 local on Oct 31 is 20:30 UTC on Oct 30: the old UTC-date comparison called that 'yesterday'."""
    monkeypatch.setenv("TZ", "Asia/Kolkata")
    time.tzset()
    try:
        from app.services import usage as mod

        start = mod.local_midnight_utc()                                                    # local 00:00 expressed in UTC
        assert start.endswith("+00:00") and start[11:16] in {"18:30"}                       # 00:00 IST == 18:30 UTC the day before
        just_after_local_midnight = (datetime.fromisoformat(start) + timedelta(hours=2)).isoformat(timespec="seconds")
        just_before = (datetime.fromisoformat(start) - timedelta(hours=1)).isoformat(timespec="seconds")
        with container.db.tx() as c:
            for ts, ms in ((just_after_local_midnight, 1000), (just_before, 7000)):
                c.execute("INSERT INTO llm_usage(created_at, model, purpose, total_ms) VALUES (?, ?, 'evaluation', ?)", (ts, MODEL, ms))
        assert container.usage.totals()["today"]["seconds"] == 1.0                            # only the call after local midnight
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


OLD_V3_USAGE = OLD_V2_USAGE.replace("detail TEXT\n);", "detail TEXT, interview_id INTEGER, label TEXT\n);")


def test_a_v3_database_gets_provider_and_cost_columns_and_old_rows_count_as_free_local_calls(tmp_path):
    """This is the exact upgrade a pre-cloud install takes."""
    path = tmp_path / "v3.sqlite3"
    raw = sqlite3.connect(path)
    for stmt in _split_statements(SCHEMA.replace(USAGE_SCHEMA, "") + OLD_V3_USAGE):
        raw.execute(stmt)
    raw.execute("INSERT INTO llm_usage(created_at, model, purpose, total_ms, interview_id, label) VALUES ('2026-10-30T10:00:00+00:00', 'qwen3.5:4b', 'evaluation', 21000, 7, 'Q2')")
    raw.execute("PRAGMA user_version=3")
    raw.commit(); raw.close()
    db = Database(path)
    with db.read() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        row = c.execute("SELECT provider, cost_usd, interview_id, label FROM llm_usage").fetchone()
    assert tuple(row) == ("local", None, 7, "Q2")                                          # untouched, and a local call costs nothing
    Database(path)                                                                          # opening again is a no-op
