"""The model costs ~4 GB. On an 8 GB computer, loading it at the wrong moment swaps other apps to disk and freezes the machine,
so the app (1) warms the model early, (2) releases it as soon as practice is over and (3) warns when memory is tight."""
import time

import pytest
from fastapi.testclient import TestClient

from app.deps import build_container
from app.main import create_app
from app.services import sysmem
from app.services.sysmem import memory_advice, parse_meminfo, parse_memory_pressure
from conftest import InlineExecutor, act, add_questions, answer, make_client_for, make_settings, start_interview, state

MODEL = "qwen3.5:4b"


def make_client(tmp_path, fake, **settings_kw) -> TestClient:
    s = make_settings(tmp_path, **settings_kw)
    return TestClient(create_app(s, build_container(s, ollama=make_client_for(s, fake), executor=InlineExecutor())), base_url="http://127.0.0.1:3000")


def unloads(fake) -> list[dict]:
    return [c for c in fake.generate_calls if c.get("keep_alive") == 0 and c["model"] == MODEL]


def finish_one_question_interview(client, set_id):
    st = start_interview(client, set_id, max_followups=0)
    st = answer(client, st).json()
    return act(client, state(client, st["id"]), "continue").json()


# ---------------------------------------------------------------- reading memory
def test_parse_macos_memory_pressure():
    assert parse_memory_pressure("The system has 8589934592 (524288 pages)\nSystem-wide memory free percentage: 32%\n") == 0.32
    assert parse_memory_pressure("nothing useful") is None


def test_parse_linux_meminfo():
    total, avail = parse_meminfo("MemTotal:        8000000 kB\nMemFree:  100 kB\nMemAvailable:    2000000 kB\n")
    assert total == pytest.approx(7.63, abs=0.01) and avail == pytest.approx(1.91, abs=0.01)
    assert parse_meminfo("garbage") is None


def test_advice_warns_only_when_loading_the_model_would_cause_swapping():
    ram = {"total_gb": 8.0, "available_gb": 2.6}
    assert memory_advice(ram, 4.3, model_loaded=False)["tight"] is True
    assert memory_advice(ram, 4.3, model_loaded=True)["tight"] is False                    # already in memory: nothing to load
    assert memory_advice({"total_gb": 16.0, "available_gb": 9.0}, 4.3, model_loaded=False)["tight"] is False
    assert memory_advice({"total_gb": 8.0, "available_gb": 4.7}, 4.3, model_loaded=False)["tight"] is True   # needs a 0.5 GB margin too
    assert memory_advice(None, 4.3, model_loaded=False) is None


def test_memory_reading_is_cached_for_a_few_seconds(monkeypatch):
    calls = []
    monkeypatch.setattr(sysmem, "_read", lambda: calls.append(1) or {"total_gb": 8.0, "available_gb": 3.0})
    monkeypatch.setattr(sysmem, "_CACHE", (0.0, None))
    assert sysmem.read_memory()["available_gb"] == 3.0
    assert sysmem.read_memory()["available_gb"] == 3.0
    assert len(calls) == 1                                  # the second call came from the cache (health is polled on every page change)


def test_an_unreadable_system_gives_none_instead_of_an_error(monkeypatch):
    monkeypatch.setattr(sysmem.sys, "platform", "darwin")
    monkeypatch.setattr(sysmem.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no such command")))
    assert sysmem._read() is None


def test_health_reports_memory_advice(client, fake, monkeypatch):
    monkeypatch.setattr("app.routers.system.read_memory", lambda: {"total_gb": 8.0, "available_gb": 2.4})
    fake.models = [MODEL, "phonon:latest"]
    mem = client.get("/api/health").json()["memory"]
    assert mem["tight"] is True and mem["available_gb"] == 2.4 and mem["needs_gb"] >= 4.0
    fake.loaded = [MODEL]
    assert client.get("/api/health").json()["memory"]["tight"] is False


def test_health_survives_unknown_memory(client, monkeypatch):
    monkeypatch.setattr("app.routers.system.read_memory", lambda: None)
    assert client.get("/api/health").json()["memory"] is None


# ---------------------------------------------------------------- warming the model early
def test_warm_endpoint_loads_the_model_once(client, fake):
    r = client.post("/api/llm/warm")
    assert r.status_code == 200 and r.json()["status"] == "loading"
    assert fake.loaded == [MODEL]
    load = [c for c in fake.generate_calls if c["model"] == MODEL][0]
    assert load["keep_alive"] == "10m" and "prompt" not in load                            # loads only: nothing is generated
    assert client.post("/api/llm/warm").json()["status"] == "loaded"
    assert fake.loaded == [MODEL]                                                          # still ONE model in memory, never a second copy


def test_warm_up_loads_the_model_with_the_same_context_window_as_real_requests(client, fake, settings):
    """A warm-up without the app's num_ctx once loaded a 4096-token context instead of the designed 6144 (measured)."""
    client.post("/api/llm/warm")
    load = [c for c in fake.generate_calls if c["model"] == MODEL][0]
    assert load["options"]["num_ctx"] == settings.llm_num_ctx == 6144
    from conftest import make_client_for
    real = make_client_for(settings, fake)._payload([{"role": "user", "content": "x"}], {}, MODEL, None, None, think=False)
    assert real["options"]["num_ctx"] == load["options"]["num_ctx"] and real["keep_alive"] == load["keep_alive"]


def test_warming_again_restarts_the_idle_timer_instead_of_reloading(client, fake):
    client.post("/api/llm/warm")
    client.post("/api/llm/warm")
    refresh = [c for c in fake.generate_calls if c["model"] == MODEL]
    assert len(refresh) == 2 and all(c["keep_alive"] == "10m" for c in refresh)           # each call renews the timer
    assert fake.loaded == [MODEL]


def test_warm_never_fails_when_ollama_is_down(client, fake):
    fake.up = False
    assert client.post("/api/llm/warm").status_code == 200


def test_warm_does_not_wait_behind_a_running_generation(settings, fake):
    ollama = make_client_for(settings, fake)
    ollama.llm_lock.acquire()
    try:
        t0 = time.time()
        assert ollama.warm(MODEL) is True and time.time() - t0 < 1 and fake.generate_calls == []
    finally:
        ollama.llm_lock.release()


# ---------------------------------------------------------------- releasing the model when practice is over
def test_model_is_released_when_the_last_interview_finishes(client, set_id, fake):
    add_questions(client, set_id, 1)
    fake.loaded = [MODEL]
    st = finish_one_question_interview(client, set_id)
    assert st["status"] == "completed"
    assert len(unloads(fake)) == 1 and fake.loaded == []


def test_model_stays_loaded_while_another_interview_is_running(client, set_id, fake):
    """Older databases can hold two running interviews (the app now allows only one); the model must stay while either runs."""
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    with client.app.state.c.db.tx() as c:
        c.execute("""INSERT INTO interviews(set_id, title, interview_type, status, phase, config_json, created_at, started_at, updated_at)
                     SELECT set_id, 'Legacy', interview_type, 'in_progress', 'awaiting_answer', config_json, created_at, started_at, updated_at FROM interviews WHERE id=?""", (st["id"],))
        other = c.execute("SELECT MAX(id) FROM interviews").fetchone()[0]
    fake.loaded = [MODEL]
    st = answer(client, st).json()
    act(client, state(client, st["id"]), "continue")
    assert unloads(fake) == [] and fake.loaded == [MODEL]
    assert state(client, other)["status"] == "in_progress"


def test_model_is_released_on_pause_and_end(client, set_id, fake):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id, max_followups=0)
    fake.loaded = [MODEL]
    assert client.post(f"/api/interviews/{st['id']}/pause").status_code == 200
    assert len(unloads(fake)) == 1
    client.post(f"/api/interviews/{st['id']}/resume")
    fake.loaded = [MODEL]
    assert client.post(f"/api/interviews/{st['id']}/end").status_code == 200
    assert len(unloads(fake)) == 2


def test_release_can_be_switched_off(tmp_path, fake):
    c = make_client(tmp_path, fake, llm_unload_when_idle=False)
    set_id = c.get("/api/sets").json()[0]["id"]
    add_questions(c, set_id, 1)
    fake.loaded = [MODEL]
    finish_one_question_interview(c, set_id)
    assert unloads(fake) == [] and fake.loaded == [MODEL]


def test_a_failing_release_never_breaks_the_interview(client, set_id, fake):
    add_questions(client, set_id, 1)
    fake.generate_fails = True                               # Ollama refuses the unload request
    st = finish_one_question_interview(client, set_id)
    assert st["status"] == "completed"
    assert client.get(f"/api/interviews/{st['id']}/report").status_code == 200   # and the report is still produced


def test_a_failing_warm_up_is_harmless(client, fake):
    fake.generate_fails = True
    assert client.post("/api/llm/warm").status_code == 200
    assert fake.loaded == []


def test_unload_setting_is_read_from_the_environment(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("LLM_UNLOAD_WHEN_IDLE", "0")
    assert Settings.from_env().llm_unload_when_idle is False
    monkeypatch.delenv("LLM_UNLOAD_WHEN_IDLE")
    assert Settings.from_env().llm_unload_when_idle is True
