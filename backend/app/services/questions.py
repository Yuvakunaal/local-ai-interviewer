"""Question sets and questions: CRUD, ordering, import/export. All writes are single transactions."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Any, Optional

from ..config import Settings
from ..db import Database, utcnow
from ..errors import AppError, bad_request, not_found
from ..parsing import normalize_for_dedupe, preview_json, preview_text
from ..schemas import (ImportCommitIn, ImportCommitOut, ImportPreviewIn, ImportPreviewOut, QuestionIn, RubricSettings)

DEFAULT_SET_NAME = "My Questions"


def _q(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


class QuestionService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.ensure_default_set()

    # ------------------------------------------------------------------ sets
    def ensure_default_set(self) -> None:
        with self.db.tx() as c:
            if c.execute("SELECT COUNT(*) FROM question_sets").fetchone()[0] == 0:
                now = utcnow()
                c.execute("INSERT INTO question_sets(name, created_at, updated_at) VALUES (?,?,?)",
                          (DEFAULT_SET_NAME, now, now))

    def list_sets(self) -> list[dict[str, Any]]:
        with self.db.read() as c:
            rows = c.execute("""SELECT s.*, (SELECT COUNT(*) FROM questions q WHERE q.set_id=s.id) AS question_count
                                FROM question_sets s ORDER BY s.id""").fetchall()
        return [_q(r) for r in rows]

    def create_set(self, name: str) -> dict[str, Any]:
        with self.db.tx() as c:
            now = utcnow()
            cur = c.execute("INSERT INTO question_sets(name, created_at, updated_at) VALUES (?,?,?)", (name, now, now))
            sid = cur.lastrowid
        return self.get_set(sid)

    def get_set(self, set_id: int) -> dict[str, Any]:
        with self.db.read() as c:
            row = c.execute("""SELECT s.*, (SELECT COUNT(*) FROM questions q WHERE q.set_id=s.id) AS question_count
                               FROM question_sets s WHERE s.id=?""", (set_id,)).fetchone()
        if not row:
            raise not_found("Question set")
        return _q(row)

    def rename_set(self, set_id: int, name: str) -> dict[str, Any]:
        with self.db.tx() as c:
            if not c.execute("UPDATE question_sets SET name=?, updated_at=? WHERE id=?", (name, utcnow(), set_id)).rowcount:
                raise not_found("Question set")
        return self.get_set(set_id)

    def delete_set(self, set_id: int) -> None:
        with self.db.tx() as c:
            if c.execute("SELECT COUNT(*) FROM question_sets").fetchone()[0] <= 1:
                raise bad_request("last_set", "You need at least one question set; create another before deleting this one.")
            if not c.execute("DELETE FROM question_sets WHERE id=?", (set_id,)).rowcount:
                raise not_found("Question set")

    # ------------------------------------------------------------------ questions
    def list_questions(self, set_id: int) -> list[dict[str, Any]]:
        self.get_set(set_id)
        with self.db.read() as c:
            rows = c.execute("SELECT * FROM questions WHERE set_id=? ORDER BY position, id", (set_id,)).fetchall()
        return [_q(r) for r in rows]

    def get_question(self, qid: int) -> dict[str, Any]:
        with self.db.read() as c:
            row = c.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
        if not row:
            raise not_found("Question")
        return _q(row)

    def add_question(self, set_id: int, q: QuestionIn, *, after_id: Optional[int] = None) -> dict[str, Any]:
        with self.db.tx() as c:
            if not c.execute("SELECT 1 FROM question_sets WHERE id=?", (set_id,)).fetchone():
                raise not_found("Question set")
            if after_id is None:
                pos = c.execute("SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE set_id=?", (set_id,)).fetchone()[0]
            else:
                base = c.execute("SELECT position FROM questions WHERE id=? AND set_id=?", (after_id, set_id)).fetchone()
                if not base:
                    raise not_found("Question")
                pos = base[0] + 1
                c.execute("UPDATE questions SET position=position+1 WHERE set_id=? AND position>=?", (set_id, pos))
            now = utcnow()
            cur = c.execute("""INSERT INTO questions(set_id, position, text, rubric, topic, difficulty, created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?)""", (set_id, pos, q.text, q.rubric, q.topic, q.difficulty, now, now))
            qid = cur.lastrowid
        return self.get_question(qid)

    def update_question(self, qid: int, q: QuestionIn) -> dict[str, Any]:
        with self.db.tx() as c:
            n = c.execute("""UPDATE questions SET text=?, rubric=?, topic=?, difficulty=?, updated_at=? WHERE id=?""",
                          (q.text, q.rubric, q.topic, q.difficulty, utcnow(), qid)).rowcount
            if not n:
                raise not_found("Question")
        return self.get_question(qid)

    def delete_question(self, qid: int) -> None:
        with self.db.tx() as c:
            row = c.execute("SELECT set_id FROM questions WHERE id=?", (qid,)).fetchone()
            if not row:
                raise not_found("Question")
            c.execute("DELETE FROM questions WHERE id=?", (qid,))
            self._renumber(c, row[0])

    def duplicate_question(self, qid: int) -> dict[str, Any]:
        src = self.get_question(qid)
        return self.add_question(src["set_id"], QuestionIn(text=src["text"], rubric=src["rubric"], topic=src["topic"],
                                                           difficulty=src["difficulty"]), after_id=qid)

    def reorder(self, set_id: int, ordered_ids: list[int]) -> list[dict[str, Any]]:
        with self.db.tx() as c:
            current = [r[0] for r in c.execute("SELECT id FROM questions WHERE set_id=? ORDER BY position, id", (set_id,))]
            if sorted(current) != sorted(ordered_ids) or len(set(ordered_ids)) != len(ordered_ids):
                raise bad_request("bad_order", "The new order must list every question in the set exactly once.")
            for pos, qid in enumerate(ordered_ids):
                c.execute("UPDATE questions SET position=? WHERE id=?", (pos, qid))
        return self.list_questions(set_id)

    @staticmethod
    def _renumber(c: sqlite3.Connection, set_id: int) -> None:
        ids = [r[0] for r in c.execute("SELECT id FROM questions WHERE set_id=? ORDER BY position, id", (set_id,))]
        for pos, qid in enumerate(ids):
            c.execute("UPDATE questions SET position=? WHERE id=?", (pos, qid))

    # ------------------------------------------------------------------ import / export
    def preview_import(self, set_id: int, body: ImportPreviewIn) -> ImportPreviewOut:
        existing = [q["text"] for q in self.list_questions(set_id)]
        return preview_json(body.content, existing) if body.format == "json" else preview_text(body.content, existing)

    def commit_import(self, set_id: int, body: ImportCommitIn) -> ImportCommitOut:
        if not body.questions:
            raise bad_request("nothing_to_import", "There are no questions to import.")
        if body.mode == "replace" and not body.confirm_replace:
            raise bad_request("confirm_required", "Replacing the queue requires explicit confirmation.")
        backup_file = None
        removed = 0
        if body.mode == "replace":
            backup_file = self._backup_set(set_id)  # safety net before anything is removed
        with self.db.tx() as c:
            if not c.execute("SELECT 1 FROM question_sets WHERE id=?", (set_id,)).fetchone():
                raise not_found("Question set")
            if body.mode == "replace":
                removed = c.execute("DELETE FROM questions WHERE set_id=?", (set_id,)).rowcount
            seen = {normalize_for_dedupe(r[0]) for r in c.execute("SELECT text FROM questions WHERE set_id=?", (set_id,))}
            pos = c.execute("SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE set_id=?", (set_id,)).fetchone()[0]
            added = skipped = 0
            now = utcnow()
            for q in body.questions:
                key = normalize_for_dedupe(q.text)
                if key in seen:
                    skipped += 1
                    continue
                seen.add(key)
                c.execute("""INSERT INTO questions(set_id, position, text, rubric, topic, difficulty, created_at, updated_at)
                             VALUES (?,?,?,?,?,?,?,?)""", (set_id, pos, q.text, q.rubric, q.topic, q.difficulty, now, now))
                pos += 1
                added += 1
            c.execute("UPDATE question_sets SET updated_at=? WHERE id=?", (now, set_id))
        return ImportCommitOut(added=added, skipped_duplicates=skipped, removed=removed, backup_file=backup_file)

    def _backup_set(self, set_id: int) -> Optional[str]:
        qs = self.list_questions(set_id)
        if not qs:
            return None
        self.settings.backup_dir.mkdir(parents=True, exist_ok=True)
        path = self.settings.backup_dir / f"set-{set_id}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        path.write_text(json.dumps(self.export_set(set_id), indent=2, ensure_ascii=False), encoding="utf-8")
        return path.name

    def export_set(self, set_id: int) -> dict[str, Any]:
        s = self.get_set(set_id)
        return {
            "version": 1,
            "name": s["name"],
            "questions": [
                {k: v for k, v in {"text": q["text"], "rubric": q["rubric"], "topic": q["topic"],
                                   "difficulty": q["difficulty"]}.items() if v}
                for q in self.list_questions(set_id)
            ],
        }

    # ------------------------------------------------------------------ rubric settings
    def get_rubric(self) -> RubricSettings:
        with self.db.read() as c:
            row = c.execute("SELECT value FROM settings WHERE key='rubric'").fetchone()
        if not row:
            return RubricSettings()
        try:
            return RubricSettings.model_validate(json.loads(row[0]))
        except Exception:
            return RubricSettings()

    def set_rubric(self, rubric: RubricSettings) -> RubricSettings:
        with self.db.tx() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('rubric',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (rubric.model_dump_json(),))
        return rubric
