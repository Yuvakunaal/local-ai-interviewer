import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, is_loopback_url

ROOT = Path(__file__).resolve().parents[2]


def test_non_loopback_host_header_rejected(client):
    ok = client.get("/api/health")
    assert ok.status_code == 200 and ok.json()["local_only"] is True
    for host in ("evil.example.com", "192.168.1.20:3000", "127.0.0.1.evil.com"):
        r = client.get("/api/health", headers={"host": host})
        assert r.status_code == 403, host


def test_cross_site_post_rejected_but_local_origin_allowed(client, set_id):
    body = {"text": "A question?"}
    assert client.post(f"/api/sets/{set_id}/questions", json=body, headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post(f"/api/sets/{set_id}/questions", json=body, headers={"origin": "http://localhost:3000"}).status_code == 201
    assert client.post(f"/api/sets/{set_id}/questions", json=body, headers={"origin": "http://127.0.0.1:5173"}).status_code == 201


def test_no_cors_headers_are_ever_sent(client):
    r = client.get("/api/health", headers={"origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_remote_ollama_url_is_refused(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST_URL", "http://10.0.0.5:11434")
    monkeypatch.delenv("ALLOW_NON_LOCAL_OLLAMA", raising=False)
    with pytest.raises(RuntimeError, match="loopback"):
        Settings.from_env()
    assert is_loopback_url("http://localhost:11434") and not is_loopback_url("https://api.openai.com")


def test_default_bind_is_loopback():
    assert Settings().host == "127.0.0.1"
    launcher = (ROOT / "scripts" / "manage.py").read_text(encoding="utf-8")   # start.sh / start.bat both delegate to it
    assert 'os.environ.get("APP_HOST", "127.0.0.1")' in launcher and "is not loopback. Refusing" in launcher
    assert '"--host", "127.0.0.1"' in launcher                                  # the server is always started on loopback


def test_all_outbound_traffic_goes_only_to_the_ollama_host(client, set_id, fake):
    from conftest import add_questions, answer, act, start_interview
    add_questions(client, set_id, 1)
    st = start_interview(client, set_id, max_followups=0)
    act(client, answer(client, st).json(), "continue")
    client.post("/api/speech/synthesize", json={"text": "Hi there", "voice": "Harper"})
    client.get("/api/health")
    assert fake.hosts == {"127.0.0.1"}


def test_source_has_no_hardcoded_external_urls():
    """Backend and frontend sources may only reference loopback URLs (plus XML/W3C namespace strings)."""
    allowed = re.compile(r"https?://(127\.0\.0\.1|localhost|\[::1\]|www\.w3\.org)")
    # The ONE deliberate exception: Ollama's cloud address, which exists only so the user can opt in to cloud mode (Settings -> AI models).
    # It must live in config.py and nowhere else, so nothing can quietly talk to another host.
    cloud_exception = ("backend/app/config.py", "https://ollama.com")
    # Documentation links the setup screen shows ("install Ollama / Python / Node here"). The app never requests them; the user may click.
    help_links = {"https://ollama.com/download", "https://ollama.com/install.sh", "https://www.python.org/downloads/", "https://nodejs.org/"}
    offenders = []
    files = list((ROOT / "backend" / "app").rglob("*.py")) + [p for p in (ROOT / "frontend" / "src").rglob("*") if p.suffix in {".ts", ".tsx", ".css", ".html"}]
    files.append(ROOT / "frontend" / "index.html")
    for f in files:
        if not f.is_file():
            continue
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in re.finditer(r"https?://[^\s\"')>]+", line):
                url = m.group(0).rstrip(".,;:|")
                if allowed.match(m.group(0)) or (f.relative_to(ROOT).as_posix(), m.group(0).rstrip(".,;:")) == cloud_exception \
                        or (f.relative_to(ROOT).as_posix() == "backend/app/services/setup_check.py" and url in help_links):
                    continue
                offenders.append(f"{f.relative_to(ROOT)}:{n}: {m.group(0)}")
    assert not offenders, offenders


def test_dotenv_example_loads_cleanly(tmp_path, monkeypatch):
    """.env.example carries inline comments; copying it to .env must not corrupt any value."""
    from app.config import load_dotenv

    env = tmp_path / ".env"
    env.write_text((ROOT / ".env.example").read_text(encoding="utf-8"), encoding="utf-8")
    for k in ("STT_MODEL", "LLM_NUM_CTX", "LLM_KEEP_ALIVE", "TTS_PROVIDER", "APP_PORT"):
        monkeypatch.delenv(k, raising=False)
    load_dotenv(env)
    import os

    assert os.environ["STT_MODEL"] == "base.en" and os.environ["LLM_NUM_CTX"] == "6144" and os.environ["LLM_KEEP_ALIVE"] == "10m"
    assert os.environ["TTS_PROVIDER"] == "auto" and os.environ["APP_PORT"] == "3000"
    for k in ("STT_MODEL", "LLM_NUM_CTX", "LLM_KEEP_ALIVE", "TTS_PROVIDER", "APP_PORT"):
        monkeypatch.delenv(k, raising=False)


def test_the_cloud_address_exists_in_exactly_one_place_and_is_https():
    from app.config import Settings

    assert Settings().cloud_url == "https://ollama.com"
    def without_help_links(text: str) -> str:        # the setup screen's "install Ollama" documentation links are not the cloud address
        return text.replace("https://ollama.com/download", "").replace("https://ollama.com/install.sh", "")

    hits = [f.relative_to(ROOT).as_posix() for f in (ROOT / "backend" / "app").rglob("*.py") if "https://ollama.com" in without_help_links(f.read_text(encoding="utf-8"))]
    assert hits == ["backend/app/config.py"], hits


@pytest.mark.parametrize("url, ok", [("https://ollama.com", True), ("https://proxy.example.com/ollama", True), ("http://127.0.0.1:9999", True),
                                      ("http://localhost:9999", True), ("http://ollama.com", False), ("http://evil.example.com", False), ("ftp://x", False)])
def test_cloud_url_must_be_https_unless_it_is_a_loopback_test_server(monkeypatch, url, ok):
    from app.config import Settings

    monkeypatch.setenv("OLLAMA_CLOUD_URL", url)
    if ok:
        assert Settings.from_env().cloud_url == url
    else:
        with pytest.raises(RuntimeError, match="OLLAMA_CLOUD_URL"):
            Settings.from_env()
