"""The built web app is served efficiently: compressed, cached when its file name carries a content hash, re-checked otherwise."""
import dataclasses

from fastapi.testclient import TestClient

from app.deps import build_container
from app.main import create_app
from tests.conftest import InlineExecutor, make_client_for


def make_app_client(settings, fake, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>x</title>" + "<p>hello</p>" * 200, encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log('x');" * 400, encoding="utf-8")
    (dist / "logo.svg").write_text("<svg/>", encoding="utf-8")
    s = dataclasses.replace(settings, frontend_dist=dist)
    c = build_container(s, ollama=make_client_for(s, fake), executor=InlineExecutor())
    return TestClient(create_app(s, c), base_url="http://127.0.0.1:3000")


def test_hashed_assets_are_cached_for_good_and_the_page_is_always_rechecked(settings, fake, tmp_path):
    c = make_app_client(settings, fake, tmp_path)
    js = c.get("/assets/index-abc123.js")
    assert js.status_code == 200 and "immutable" in js.headers["cache-control"] and "max-age=31536000" in js.headers["cache-control"]
    assert c.get("/").headers["cache-control"] == "no-cache"
    assert c.get("/some/deep/route").headers["cache-control"] == "no-cache"          # single-page app fallback
    assert c.get("/logo.svg").headers["cache-control"] == "no-cache"                  # not content-hashed


def test_pages_scripts_and_json_are_compressed_when_large_enough(settings, fake, tmp_path):
    c = make_app_client(settings, fake, tmp_path)
    assert c.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"}).headers.get("content-encoding") == "gzip"
    assert c.get("/", headers={"Accept-Encoding": "gzip"}).headers.get("content-encoding") == "gzip"
    assert c.get("/", headers={"Accept-Encoding": "identity"}).headers.get("content-encoding") is None             # only when the browser accepts it


def test_speech_routes_are_never_compressed(settings, fake, tmp_path):
    c = make_app_client(settings, fake, tmp_path)
    r = c.get("/api/speech/stt", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") is None
