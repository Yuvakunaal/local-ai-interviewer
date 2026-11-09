"""First-run setup: the report says exactly what is missing; the model can be downloaded with one click and a visible progress."""
import time

import pytest

from app.services import setup_check
from conftest import add_questions


def report(client):
    r = client.get("/api/setup")
    assert r.status_code == 200, r.text
    return r.json()


def item(rep, id_):
    return next(i for i in rep["items"] if i["id"] == id_)


def test_everything_present_means_no_setup_screen(client):
    rep = report(client)
    assert rep["ready"] is True and rep["needs_setup"] is False and rep["blocking"] == []
    assert item(rep, "python")["status"] == "ok" and item(rep, "ollama")["status"] == "ok" and item(rep, "model")["status"] == "ok"


def test_ollama_not_running_and_not_installed_gives_install_steps_for_this_os(client, fake, monkeypatch):
    fake.up = False
    monkeypatch.setattr(setup_check, "find_ollama", lambda: None)
    for system in ("macos", "windows", "linux"):
        monkeypatch.setattr(setup_check, "os_key", lambda s=system: s)
        rep = report(client)
        o = item(rep, "ollama")
        assert rep["needs_setup"] is True and o["status"] == "missing" and o["detail"] == "not installed" and "ollama" in rep["blocking"]
        steps = o["help"]["steps"]
        assert any("command" in s_ or "url" in s_ for s_ in steps)
        text = " ".join(str(v) for s_ in steps for v in s_.values())
        assert {"macos": "brew install ollama", "windows": "winget install Ollama.Ollama", "linux": "install.sh"}[system] in text


def test_ollama_installed_but_not_running_says_to_open_it(client, fake, monkeypatch):
    fake.up = False
    monkeypatch.setattr(setup_check, "find_ollama", lambda: "/usr/local/bin/ollama")
    o = item(report(client), "ollama")
    assert o["status"] == "missing" and o["detail"] == "installed, but not running" and "not running" in o["help"]["summary"]
    assert any(s.get("command") == "ollama serve" for s in o["help"]["steps"])


def test_a_missing_model_offers_a_download_and_shows_the_size(client, fake):
    fake.models = ["something-else:1b"]
    rep = report(client)
    m = item(rep, "model")
    assert rep["needs_setup"] is True and m["status"] == "missing" and m["action"] == "pull_llm" and "4 GB" in m["detail"]
    assert rep["downloads"]["model"] == "qwen3.5:4b" and rep["downloads"]["size_gb"] == 4.0


def test_the_model_download_waits_for_ollama(client, fake):
    fake.models = []
    fake.up = False
    rep = report(client)
    assert item(rep, "model")["action"] is None and "needs Ollama running first" in item(rep, "model")["detail"]


def test_cloud_mode_checks_the_key_not_ollama(client, fake):
    from conftest import enable_cloud
    fake.up = False
    rep = report(client)
    assert rep["mode"] == "local" and rep["needs_setup"] is True
    enable_cloud(client)
    rep = report(client)
    assert rep["mode"] == "cloud" and rep["ready"] is True and rep["needs_setup"] is False
    assert [i["id"] for i in rep["items"] if i["required"]] == ["python", "cloud"]
    client.delete("/api/ai/key")                                             # no key: back to local, which is not ready
    assert report(client)["needs_setup"] is True


def test_optional_items_never_block(client, monkeypatch):
    rep = report(client)
    assert {i["id"] for i in rep["items"] if not i["required"]} >= {"voice", "mic"}
    assert all(i["status"] in ("ok", "optional", "warn") for i in rep["items"] if not i["required"])
    assert rep["ready"] is True


def test_low_disk_space_is_a_warning_before_the_download(client, fake, monkeypatch):
    fake.models = []
    monkeypatch.setattr(setup_check, "free_gb", lambda path=None: 2.0)
    d = item(report(client), "disk")
    assert d["status"] == "warn" and "needs about 4 GB" in d["detail"]


def test_report_is_read_only_and_makes_no_download(client, fake):
    fake.models = []
    report(client)
    assert fake.pull_calls == []


# ---------------------------------------------------------------- the one-click download
def wait_done(client, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        s = client.get("/api/setup/pull").json()
        if s["state"] not in ("pulling",):
            return s
        time.sleep(0.02)
    raise AssertionError("pull did not finish")


def test_pull_downloads_the_configured_model_and_reports_progress(client, fake):
    fake.models = []
    r = client.post("/api/setup/pull", json={"which": "llm"})
    assert r.status_code == 200 and r.json()["model"] == "qwen3.5:4b"
    done = wait_done(client)
    assert done["state"] == "done" and done["percent"] == 100 and fake.pull_calls == [{"model": "qwen3.5:4b", "stream": True}]
    assert item(report(client), "model")["status"] == "ok"                  # and the check now passes


def test_only_the_apps_own_models_can_be_pulled(client, fake):
    assert client.post("/api/setup/pull", json={"which": "everything"}).status_code == 422
    assert fake.pull_calls == []


def test_a_failed_download_reports_why_and_can_be_retried(client, fake):
    fake.models = []
    fake.pull_fail = "pull model manifest: file does not exist"
    client.post("/api/setup/pull", json={"which": "llm"})
    s = wait_done(client)
    assert s["state"] == "error" and "does not exist" in s["error"]
    fake.pull_fail = None
    client.post("/api/setup/pull", json={"which": "llm"})
    assert wait_done(client)["state"] == "done"


def test_pull_needs_ollama_running_and_enough_disk(client, fake, monkeypatch):
    fake.up = False
    r = client.post("/api/setup/pull", json={"which": "llm"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "ollama_unavailable"
    fake.up = True
    from app.services import model_pull
    monkeypatch.setattr(model_pull, "free_gb", lambda path=None: 1.5)
    r = client.post("/api/setup/pull", json={"which": "llm"})
    assert r.status_code == 507 and r.json()["error"]["code"] == "disk_full" and "1.5 GB free" in r.json()["error"]["message"]


def test_only_one_download_at_a_time(client, fake):
    from app.services.model_pull import ModelPuller
    p: ModelPuller = client.app.state.c.puller
    import threading
    gate = threading.Event()
    original = p.ollama.pull_stream

    def slow(model):
        yield {"status": "pulling manifest"}
        gate.wait(2)
        yield {"status": "success"}

    p.ollama.pull_stream = slow
    try:
        assert client.post("/api/setup/pull", json={"which": "llm"}).status_code == 200
        again = client.post("/api/setup/pull", json={"which": "llm"})
        assert again.status_code == 409 and again.json()["error"]["code"] == "pull_running"
    finally:
        gate.set()
        p.wait()
        p.ollama.pull_stream = original


def test_a_download_can_be_cancelled(client, fake):
    from app.services.model_pull import ModelPuller
    import threading
    p: ModelPuller = client.app.state.c.puller
    gate = threading.Event()

    def slow(model):
        for i in range(50):
            yield {"status": "pulling x", "total": 100, "completed": i}
            gate.wait(0.05)

    p.ollama.pull_stream = slow
    assert client.post("/api/setup/pull", json={"which": "llm"}).status_code == 200
    time.sleep(0.15)
    client.delete("/api/setup/pull")
    s = wait_done(client)
    assert s["state"] == "cancelled" and "resumes" in s["status"]
