import io
import wave

import pytest

from app.services.tts import SpeechError, chunk_text, pcm_is_silent, wav_from_pcm


def test_chunking_respects_sentences_and_limit():
    text = "First sentence here. " * 40
    chunks = chunk_text(text, 100)
    assert all(len(c) <= 100 for c in chunks) and " ".join(chunks).replace("  ", " ").startswith("First sentence here.")
    assert chunk_text("x" * 1000, 100) and all(len(c) <= 100 for c in chunk_text("x" * 1000, 100))
    assert chunk_text("   ") == []


def test_wav_header_is_valid():
    wav = wav_from_pcm(b"\x01\x00" * 24000)
    with wave.open(io.BytesIO(wav)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()) == (24000, 1, 2, 24000)
    assert pcm_is_silent(b"\x00\x00" * 24000) and not pcm_is_silent(b"\x00\x30" * 24000)


def test_voices_come_from_the_model(client):
    r = client.get("/api/voices").json()
    assert r["voices"] == ["default", "Harper", "Hugh"] and r["speed_supported"] is False


def test_synthesize_returns_wav_and_caches(client, fake):
    r = client.post("/api/speech/synthesize", json={"text": "Hello there. How are you?", "voice": "Harper"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnframes() > 10000
    n = len(fake.tts_calls)
    assert fake.tts_calls[0]["response_format"] == "pcm" and "speed" not in fake.tts_calls[0]
    client.post("/api/speech/synthesize", json={"text": "Hello there. How are you?", "voice": "Harper"})
    assert len(fake.tts_calls) == n                     # second request served from the local cache
    client.post("/api/speech/synthesize", json={"text": "Hello there. How are you?", "voice": "Hugh"})
    assert len(fake.tts_calls) == n + 1                 # different voice -> different audio


def test_long_text_is_chunked_into_several_requests(client, fake):
    text = " ".join(f"This is sentence number {i} about pipelines." for i in range(30))
    assert client.post("/api/speech/synthesize", json={"text": text, "voice": "default"}).status_code == 200
    assert len(fake.tts_calls) > 2 and all(len(c["input"]) <= 380 for c in fake.tts_calls)


def test_unknown_voice_empty_text_and_empty_audio(client, fake):
    r = client.post("/api/speech/synthesize", json={"text": "Hi", "voice": "Nope"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_voice"
    assert client.post("/api/speech/synthesize", json={"text": "", "voice": "default"}).status_code == 422
    fake.tts_silent = True
    r = client.post("/api/speech/synthesize", json={"text": "Silence please", "voice": "default"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "empty_audio"


def test_speech_when_ollama_down_or_model_missing(client, fake):
    fake.up = False
    r = client.post("/api/speech/synthesize", json={"text": "Hi", "voice": "default"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "ollama_unavailable"
    fake.up = True
    fake.models = ["qwen3.5:4b"]
    client.app.state.c.speech._voices = (0.0, [])
    r = client.post("/api/speech/synthesize", json={"text": "Hi", "voice": "default"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_missing"


def test_failed_synthesis_is_not_cached(client, fake):
    fake.tts_silent = True
    client.post("/api/speech/synthesize", json={"text": "Retry me", "voice": "default"})
    fake.tts_silent = False
    assert client.post("/api/speech/synthesize", json={"text": "Retry me", "voice": "default"}).status_code == 200


def test_transcribe_reports_unavailable_model_without_network(client, monkeypatch):
    pytest.importorskip("faster_whisper", reason="the optional speech-recognition package (requirements-stt.txt) is not installed")
    st = client.get("/api/speech/stt").json()
    assert st["model"] == "base.en"
    # simulate "package present but model not downloaded" regardless of this machine's cache
    monkeypatch.setattr(type(client.app.state.c.stt), "_model_cached", lambda self: False)
    r = client.post("/api/speech/transcribe", files={"audio": ("rec.webm", b"data", "audio/webm")})
    assert r.status_code == 503 and r.json()["error"]["code"] == "stt_model_missing"
    assert client.post("/api/speech/transcribe", files={"audio": ("rec.webm", b"", "audio/webm")}).status_code == 400


def test_transcribe_errors_are_mapped(client, monkeypatch):
    from app.services.stt import TranscribeError
    stt = client.app.state.c.stt
    monkeypatch.setattr(stt, "transcribe", lambda path: (_ for _ in ()).throw(TranscribeError("empty_audio", "No speech was detected.")))
    r = client.post("/api/speech/transcribe", files={"audio": ("rec.webm", b"x", "audio/webm")})
    assert r.status_code == 422 and "No speech" in r.json()["error"]["message"]
    monkeypatch.setattr(stt, "transcribe", lambda path: "hello from the mic")
    assert client.post("/api/speech/transcribe", files={"audio": ("rec.webm", b"x", "audio/webm")}).json() == {"text": "hello from the mic"}
    # uploads are removed after use
    assert not list(client.app.state.c.settings.uploads_dir.glob("*"))


# ---------------------------------------------------------------- voice engine selection (Phonon vs system voices)
def _client_with(tmp_path, fake, **settings_kw):
    from fastapi.testclient import TestClient

    from app.deps import build_container
    from app.main import create_app
    from tests.conftest import InlineExecutor, make_client_for, make_settings

    s = make_settings(tmp_path, **settings_kw)
    return TestClient(create_app(s, build_container(s, ollama=make_client_for(s, fake), executor=InlineExecutor())),
                      base_url="http://127.0.0.1:3000")


def test_health_reports_phonon_when_it_works(client):
    tts = client.get("/api/health").json()["tts"]
    assert tts["engine"] == "phonon" and tts["voices"] == 3 and tts["error"] is None and tts["note"] is None


def test_auto_falls_back_to_system_voices_when_phonon_is_not_installed(tmp_path, fake):
    """Windows / Linux / Intel Mac: Ollama has no Phonon model. That must not be an error."""
    fake.models = ["qwen3.5:4b"]
    c = _client_with(tmp_path, fake)
    tts = c.get("/api/health").json()["tts"]
    assert tts["engine"] == "system" and tts["installed"] is False and tts["error"] is None and "offline voices" in tts["note"]
    v = c.get("/api/voices")
    assert v.status_code == 200 and v.json()["engine"] == "system" and v.json()["speed_supported"] is True


def test_system_provider_never_touches_phonon(tmp_path, fake):
    c = _client_with(tmp_path, fake, tts_provider="system")
    assert c.get("/api/health").json()["tts"]["engine"] == "system"
    assert c.get("/api/voices").json()["engine"] == "system"
    assert fake.tts_calls == []


def test_forced_phonon_still_reports_a_real_error(tmp_path, fake):
    fake.models = ["qwen3.5:4b"]
    c = _client_with(tmp_path, fake, tts_provider="phonon")
    tts = c.get("/api/health").json()["tts"]
    assert tts["engine"] == "phonon" and "not installed" in tts["error"]
    assert c.get("/api/voices").status_code == 503


def test_invalid_tts_provider_is_rejected(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("TTS_PROVIDER", "cloud")
    with pytest.raises(RuntimeError, match="TTS_PROVIDER"):
        Settings.from_env()


def test_install_hint_matches_the_operating_system(monkeypatch):
    from app import config

    monkeypatch.setattr(config.os, "name", "nt")
    assert config.setup_cmd("--stt") == "setup-models.bat --stt"
    monkeypatch.setattr(config.os, "name", "posix")
    assert config.setup_cmd() == "./setup-models.sh"
