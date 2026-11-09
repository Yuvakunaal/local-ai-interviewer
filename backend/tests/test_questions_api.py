import json

from conftest import add_questions


def test_default_set_exists(client):
    sets = client.get("/api/sets").json()
    assert len(sets) == 1 and sets[0]["question_count"] == 0


def test_create_edit_delete_duplicate_reorder(client, set_id):
    qs = add_questions(client, set_id, 3)
    assert [q["position"] for q in qs] == [0, 1, 2]
    # edit
    r = client.put(f"/api/questions/{qs[0]['id']}", json={"text": "  Edited?  ", "rubric": "r", "topic": " SQL ", "difficulty": "HARD"})
    assert r.status_code == 200 and r.json()["text"] == "Edited?" and r.json()["difficulty"] == "hard" and r.json()["topic"] == "SQL"
    # duplicate goes right after the source
    d = client.post(f"/api/questions/{qs[0]['id']}/duplicate").json()
    listed = client.get(f"/api/sets/{set_id}/questions").json()
    assert [q["id"] for q in listed][:2] == [qs[0]["id"], d["id"]] and [q["position"] for q in listed] == [0, 1, 2, 3]
    # reorder
    ids = [q["id"] for q in listed][::-1]
    assert [q["id"] for q in client.post(f"/api/sets/{set_id}/reorder", json={"ordered_ids": ids}).json()] == ids
    # reorder must be a permutation
    assert client.post(f"/api/sets/{set_id}/reorder", json={"ordered_ids": ids[:-1]}).status_code == 400
    # delete renumbers
    assert client.delete(f"/api/questions/{ids[0]}").status_code == 200
    assert [q["position"] for q in client.get(f"/api/sets/{set_id}/questions").json()] == [0, 1, 2]
    assert client.delete(f"/api/questions/{ids[0]}").status_code == 404


def test_validation_errors_are_readable(client, set_id):
    r = client.post(f"/api/sets/{set_id}/questions", json={"text": "   "})
    assert r.status_code == 422 and "text" in r.json()["error"]["message"]
    r = client.post(f"/api/sets/{set_id}/questions", json={"text": "ok", "difficulty": "impossible"})
    assert r.status_code == 422


def test_bulk_import_preview_and_append_keeps_existing(client, set_id):
    add_questions(client, set_id, 2)
    text = "Question number 1?\n--\nBrand new question?\n--\nAnother new one?"
    prev = client.post(f"/api/sets/{set_id}/import/preview", json={"format": "text", "content": text}).json()
    assert prev["count"] == 3 and prev["duplicates"] == 1
    assert prev["items"][0]["duplicate"] == "existing"
    r = client.post(f"/api/sets/{set_id}/import/commit", json={"mode": "append", "questions": [{"text": i["text"]} for i in prev["items"]]}).json()
    assert r == {"added": 2, "skipped_duplicates": 1, "removed": 0, "backup_file": None}
    assert len(client.get(f"/api/sets/{set_id}/questions").json()) == 4


def test_replace_requires_confirmation_and_makes_backup(client, set_id, settings):
    add_questions(client, set_id, 3)
    body = {"mode": "replace", "questions": [{"text": "Only one?"}]}
    r = client.post(f"/api/sets/{set_id}/import/commit", json=body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "confirm_required"
    assert len(client.get(f"/api/sets/{set_id}/questions").json()) == 3  # untouched
    r = client.post(f"/api/sets/{set_id}/import/commit", json={**body, "confirm_replace": True}).json()
    assert r["removed"] == 3 and r["added"] == 1 and r["backup_file"]
    backup = json.loads((settings.backup_dir / r["backup_file"]).read_text())
    assert len(backup["questions"]) == 3


def test_json_export_import_roundtrip(client, set_id):
    add_questions(client, set_id, 2, rubric="R", difficulty="easy")
    exported = client.get(f"/api/sets/{set_id}/export")
    assert "attachment" in exported.headers["content-disposition"]
    data = exported.json()
    other = client.post("/api/sets", json={"name": "Other"}).json()["id"]
    prev = client.post(f"/api/sets/{other}/import/preview", json={"format": "json", "content": json.dumps(data)}).json()
    assert prev["count"] == 2 and prev["items"][0]["rubric"] == "R" and prev["items"][0]["difficulty"] == "easy"
    bad = client.post(f"/api/sets/{other}/import/preview", json={"format": "json", "content": "{not json"}).json()
    assert bad["errors"] and bad["count"] == 0


def test_import_empty_commit_rejected(client, set_id):
    assert client.post(f"/api/sets/{set_id}/import/commit", json={"mode": "append", "questions": []}).status_code == 400


def test_cannot_delete_last_set_and_rubric_roundtrip(client, set_id):
    assert client.delete(f"/api/sets/{set_id}").status_code == 400
    r = client.put("/api/rubric", json={"correctness": 0.5, "extra_guidance": "Prefer Snowflake examples"})
    assert r.status_code == 200 and client.get("/api/rubric").json()["correctness"] == 0.5
