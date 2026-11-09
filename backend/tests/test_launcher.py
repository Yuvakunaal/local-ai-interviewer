"""scripts/manage.py is the cross-platform launcher behind start/stop/check/setup-models (.sh and .bat)."""
from __future__ import annotations

import importlib.util
import os
import socket
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def m(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("manage_under_test", ROOT / "scripts" / "manage.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "RUN_DIR", tmp_path / "run")
    monkeypatch.setattr(mod, "LOG_DIR", tmp_path / "logs")
    return mod


def test_env_values_ignore_inline_comments_but_keep_quoted_hashes(m):
    assert m.parse_env_value("base.en        # Whisper size") == "base.en"
    assert m.parse_env_value('"a # b"') == "a # b"
    assert m.parse_env_value("http://x:1/#frag") == "http://x:1/#frag"
    assert m.parse_env_value("  127.0.0.1 ") == "127.0.0.1"


def test_venv_python_location_per_os(m, tmp_path):
    assert m.venv_python(True, tmp_path) == tmp_path / "Scripts" / "python.exe"     # Windows
    assert m.venv_python(False, tmp_path) == tmp_path / "bin" / "python"            # macOS / Linux


@pytest.mark.parametrize("provider, apple_silicon, expected", [
    ("auto", True, True),      # Apple Silicon Mac: use Phonon when installed
    ("auto", False, False),    # Windows, Linux, Intel Mac: browser/system voices, never try to install Phonon
    ("phonon", False, True),   # explicit request is honoured
    ("system", True, False),   # explicit opt-out on a Mac
])
def test_phonon_is_only_wanted_where_it_can_run(m, monkeypatch, provider, apple_silicon, expected):
    monkeypatch.setattr(m, "TTS_PROVIDER", provider)
    monkeypatch.setattr(m, "APPLE_SILICON", apple_silicon)
    assert m.wants_phonon() is expected


def test_install_hints_name_the_right_package_manager(m, monkeypatch):
    for mac, win, needle in [(True, False, "brew"), (False, True, "winget"), (False, False, "apt")]:
        monkeypatch.setattr(m, "MAC", mac)
        monkeypatch.setattr(m, "WINDOWS", win)
        assert needle in m.install_hint("node")


def test_have_model_accepts_latest_tag(m):
    names = {"qwen3.5:4b", "phonon:latest"}
    assert m.have_model(names, "qwen3.5:4b") and m.have_model(names, "phonon") and not m.have_model(names, "llama3")


def test_port_busy_detects_a_listener(m):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        assert m.port_busy(port)
    assert not m.port_busy(port)


def test_spawn_detaches_logs_and_terminate_stops_the_process(m, tmp_path):
    pid = m.spawn([sys.executable, "-u", "-c", "import time; print('hello from child', flush=True); time.sleep(60)"], "child.log", tmp_path)
    try:
        assert m.pid_alive(pid)
        deadline = time.time() + 10
        log = tmp_path / "logs" / "child.log"
        while time.time() < deadline and not (log.exists() and "hello from child" in log.read_text()):
            time.sleep(0.1)
        assert "hello from child" in log.read_text()
    finally:
        m.terminate(pid)
    assert not m.pid_alive(pid)


def test_stop_never_kills_an_unrelated_process_behind_a_stale_pid_file(m, tmp_path, monkeypatch):
    pid = m.spawn([sys.executable, "-c", "import time; time.sleep(60)"], "bystander.log", tmp_path)
    try:
        m.write_pid("backend", pid)
        monkeypatch.setattr(m, "cmdline", lambda p: "some other program")        # what a recycled PID looks like
        m.stop_one("backend", "backend", "uvicorn")
        assert m.pid_alive(pid)                                                  # left alone
        assert m.read_pid("backend") is None                                     # but the stale file is cleaned up
    finally:
        m.terminate(pid)


def test_stop_stops_our_own_backend(m, tmp_path, monkeypatch):
    pid = m.spawn([sys.executable, "-c", "import time; time.sleep(60)"], "ours.log", tmp_path)
    m.write_pid("backend", pid)
    monkeypatch.setattr(m, "cmdline", lambda p: "python -m uvicorn app.main:app_factory")
    m.stop_one("backend", "backend", "uvicorn")
    assert not m.pid_alive(pid) and m.read_pid("backend") is None


def test_frontend_staleness_follows_source_and_public_files(m, tmp_path, monkeypatch):
    monkeypatch.setattr(m, "FRONTEND", tmp_path)
    for d in ("src", "public", "dist"):
        (tmp_path / d).mkdir()
    sources = [tmp_path / "index.html", tmp_path / "package.json", tmp_path / "src" / "a.ts"]
    built = tmp_path / "dist" / "index.html"
    for f in [*sources, built]:
        f.write_text("x")
    now = time.time()
    for f in sources:
        os.utime(f, (now - 100, now - 100))
    os.utime(built, (now, now))
    assert m.frontend_stale() is False                 # build is newer than every source
    logo = tmp_path / "public" / "logo.svg"
    logo.write_text("<svg/>")
    os.utime(logo, (now + 50, now + 50))
    assert m.frontend_stale() is True                  # a changed logo triggers a rebuild
    logo.unlink()
    built.unlink()
    assert m.frontend_stale() is True                  # nothing built yet


def test_wrappers_exist_for_every_command_on_every_os():
    for name in ("start", "stop", "check", "setup-models"):
        sh = (ROOT / f"{name}.sh").read_text(encoding="utf-8")
        bat = (ROOT / f"{name}.bat").read_bytes()
        assert "scripts/run.sh" in sh and name in sh
        assert b"scripts\\run.bat" in bat and b"\r\n" in bat          # batch files need CRLF line endings


def test_a_missing_ollama_is_a_warning_not_a_reason_to_refuse_to_start(m, monkeypatch, capsys):
    """Cloud mode needs no local Ollama, so start must keep going (it used to exit with an error)."""
    monkeypatch.setattr(m, "ollama_up", lambda: False)
    monkeypatch.setattr(m, "find_ollama", lambda: None)
    assert m.ensure_ollama() is False
    out = capsys.readouterr().out
    assert "Cloud mode" in out and "not installed" in out
    src = (ROOT / "scripts" / "manage.py").read_text(encoding="utf-8")
    assert "if not ensure_ollama():" not in src                      # the caller no longer turns it into an exit code


def test_an_ollama_that_will_not_start_is_also_only_a_warning(m, monkeypatch, capsys):
    monkeypatch.setattr(m, "ollama_up", lambda: False)
    monkeypatch.setattr(m, "find_ollama", lambda: "/nonexistent/ollama")
    monkeypatch.setattr(m, "spawn", lambda *a, **k: 4242)
    monkeypatch.setattr(m, "write_pid", lambda *a, **k: None)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    assert m.ensure_ollama() is False
    assert "did not start" in capsys.readouterr().out


def test_an_older_install_missing_a_new_dependency_is_topped_up_not_rebuilt(m, tmp_path, monkeypatch):
    """The PDF writer arrived after some people had already set the app up: their environment is updated in place (kept: Whisper etc.)."""
    py = tmp_path / "venv-python"
    py.write_text("")
    monkeypatch.setattr(m, "VENV_PY", py)
    state = {"installed": False}
    ran = []
    monkeypatch.setattr(m, "pip_install", lambda req: (ran.append(req.name), state.update(installed=True)))
    monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: ran.append(" ".join(map(str, cmd))) or type("R", (), {"returncode": 0 if state["installed"] else 1})())
    assert m.ensure_backend_env() is True
    assert "requirements.txt" in ran                                         # the requirements were installed...
    assert not any("venv" in x and "-m venv" in x or x.startswith("uv venv") for x in ran)   # ...without creating a new environment


def test_a_failed_top_up_is_reported_not_hidden(m, tmp_path, monkeypatch):
    py = tmp_path / "venv-python"
    py.write_text("")
    monkeypatch.setattr(m, "VENV_PY", py)
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: type("R", (), {"returncode": 1})())

    def boom(req):
        raise m.subprocess.CalledProcessError(1, "pip")

    monkeypatch.setattr(m, "pip_install", boom)
    assert m.ensure_backend_env() is False


def test_the_environment_check_includes_the_pdf_writer(m, monkeypatch):
    seen = []
    monkeypatch.setattr(m, "VENV_PY", Path(sys.executable))
    monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: seen.append(cmd[-1]) or type("R", (), {"returncode": 0})())
    m.venv_ready()
    assert "reportlab" in seen[0]


# ---------------------------------------------------------------- a missing tool: a plain "install this" page instead of a bare error
def test_the_install_help_page_ships_and_covers_every_system_and_tool():
    page = (ROOT / "scripts" / "setup-required.html").read_text(encoding="utf-8")
    for needle in ("winget install Python.Python.3.12", "brew install python", "apt install python3", "winget install OpenJS.NodeJS.LTS", "brew install node",
                   "start.bat", "./start.sh", "Ollama", "noopener"):
        assert needle in page, needle
    assert "http://" not in page and "src=\"http" not in page            # nothing is loaded from the internet


def test_missing_node_opens_the_help_page_for_node(m, monkeypatch):
    opened = []
    monkeypatch.setattr(m.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.delenv("LAI_NO_BROWSER", raising=False)
    m.open_setup_help("node")
    assert len(opened) == 1 and opened[0].startswith("file://") and opened[0].endswith("setup-required.html?need=node")


def test_the_help_page_is_not_opened_when_browsers_are_switched_off(m, monkeypatch):
    opened = []
    monkeypatch.setattr(m.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.setenv("LAI_NO_BROWSER", "1")
    m.open_setup_help("python")
    assert opened == []


@pytest.mark.skipif(os.name == "nt", reason="exercises run.sh")
def test_without_python_start_sh_explains_and_exits_cleanly(tmp_path):
    import subprocess
    env = {"PATH": str(tmp_path), "LAI_NO_BROWSER": "1", "HOME": str(tmp_path)}      # a PATH with no python at all
    r = subprocess.run(["/bin/bash", str(ROOT / "scripts" / "run.sh"), "start"], env=env, capture_output=True, text=True, timeout=20)
    assert r.returncode == 1
    assert "Python 3.10 or newer is required" in r.stderr and "Opening a page with install steps" in r.stderr


def test_ollama_autostart_can_be_switched_off(m, monkeypatch):
    started = []
    monkeypatch.setattr(m, "ollama_up", lambda: False)
    monkeypatch.setattr(m, "find_ollama", lambda: "/usr/local/bin/ollama")
    monkeypatch.setattr(m, "spawn", lambda *a, **k: started.append(a) or 123)
    monkeypatch.setattr(m, "write_pid", lambda *a, **k: None)
    monkeypatch.setenv("OLLAMA_AUTOSTART", "0")
    assert m.ensure_ollama() is False and started == []                     # installed but left alone
    monkeypatch.delenv("OLLAMA_AUTOSTART")
    monkeypatch.setattr(m, "ollama_up", lambda: bool(started))
    assert m.ensure_ollama() is True and len(started) == 1                  # the default is unchanged: it is started for you
