"""SQLite access. One short-lived connection per unit of work; explicit transactions."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 5

USAGE_SCHEMA = """
CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,             -- evaluation | repair | summary | warm | speech
    prompt_tokens INTEGER,
    output_tokens INTEGER,
    load_ms INTEGER NOT NULL DEFAULT 0,
    prompt_ms INTEGER NOT NULL DEFAULT 0,
    output_ms INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    interview_id INTEGER,              -- which interview the call was for (NULL: not tied to one)
    label TEXT,                        -- e.g. "Q2" or "Q2 follow-up" or "Report summary"
    provider TEXT NOT NULL DEFAULT 'local',   -- local | cloud
    cost_usd REAL                      -- estimated cost of a cloud call (NULL: free local call, or a cloud model with no price set)
);
CREATE INDEX idx_usage_created ON llm_usage(created_at);
"""
USAGE_V3_ALTERS = """
ALTER TABLE llm_usage ADD COLUMN interview_id INTEGER;
ALTER TABLE llm_usage ADD COLUMN label TEXT;
"""
USAGE_V4_ALTERS = """
ALTER TABLE llm_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE llm_usage ADD COLUMN cost_usd REAL;
"""

RESUME_SCHEMA = """
CREATE TABLE resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    original_filename TEXT NOT NULL,   -- display only (sanitised); never used to build a path
    stored_name TEXT NOT NULL UNIQUE,  -- <uuid>.pdf under data/resumes
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,              -- uploaded | extracting | ocr | structuring | ready | failed
    stage_detail TEXT,                 -- e.g. "page 2 of 3", "part 1 of 3", "awaiting_cloud_consent"
    error_code TEXT,
    error_message TEXT,
    extraction_method TEXT,            -- text | ocr | mixed
    raw_text TEXT,
    ai_profile_json TEXT,              -- the structure as the AI produced it ("Revert to AI version")
    profile_json TEXT,                 -- the current structure, edited by the user (source of truth for questions)
    consent_cloud INTEGER,             -- 1: may be sent to Ollama cloud, 0: declined, NULL: not asked
    revision INTEGER NOT NULL DEFAULT 0,   -- bumped on every change of name/profile: stale tabs get 409
    job_id INTEGER NOT NULL DEFAULT 0,     -- bumped when a reading job starts or is cancelled: older jobs can no longer write
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_parsed_at TEXT
);
CREATE INDEX idx_resumes_sha ON resumes(sha256);
"""
ITEMS_V5_ALTERS = """
ALTER TABLE interview_items ADD COLUMN source TEXT NOT NULL DEFAULT 'bank';
ALTER TABLE interview_items ADD COLUMN resume_id INTEGER;
ALTER TABLE interview_items ADD COLUMN resume_name TEXT;
ALTER TABLE interview_items ADD COLUMN claim_json TEXT;
"""

SCHEMA = """
CREATE TABLE question_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    rubric TEXT,
    topic TEXT,
    difficulty TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_questions_set ON questions(set_id, position);
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE interviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER REFERENCES question_sets(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    interview_type TEXT NOT NULL,
    status TEXT NOT NULL,              -- in_progress | paused | completed | ended
    phase TEXT NOT NULL,               -- awaiting_answer | evaluating | evaluation_failed | feedback | done
    config_json TEXT NOT NULL,
    current_item_id INTEGER,
    current_turn_id INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    paused_at TEXT,
    completed_at TEXT
);
CREATE TABLE interview_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    question_id INTEGER,
    text TEXT NOT NULL,
    rubric TEXT,
    topic TEXT,
    difficulty TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | answered | skipped | unanswered
    followup_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'bank',      -- bank | resume
    resume_id INTEGER,                        -- no foreign key: deleting a resume never touches interview history
    resume_name TEXT,                         -- snapshot of the resume's name when the interview was created
    claim_json TEXT,                          -- {section, label, excerpt (<= 400 chars)} the question is about
    UNIQUE (interview_id, position)
);
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES interview_items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- main | followup
    question_text TEXT NOT NULL,
    followup_reason TEXT,
    status TEXT NOT NULL,              -- asked | submitted | evaluated | skipped
    answer_text TEXT,
    answer_source TEXT,                -- typed | voice
    evaluation_json TEXT,
    score REAL,
    eval_attempts INTEGER NOT NULL DEFAULT 0,
    asked_at TEXT NOT NULL,
    submitted_at TEXT,
    evaluated_at TEXT,
    UNIQUE (item_id, seq)
);
CREATE INDEX idx_turns_interview ON turns(interview_id);
CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    narrative_status TEXT NOT NULL,    -- pending | ready | failed
    narrative_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
""" + USAGE_SCHEMA + RESUME_SCHEMA

# The schema exactly as v4 installs had it (no resumes, no item source columns). Kept for upgrade tests of older databases.
_V5_ITEM_COLUMNS = """    source TEXT NOT NULL DEFAULT 'bank',      -- bank | resume
    resume_id INTEGER,                        -- no foreign key: deleting a resume never touches interview history
    resume_name TEXT,                         -- snapshot of the resume's name when the interview was created
    claim_json TEXT,                          -- {section, label, excerpt (<= 400 chars)} the question is about
"""
SCHEMA_V4 = SCHEMA.replace(RESUME_SCHEMA, "").replace(_V5_ITEM_COLUMNS, "")
assert SCHEMA_V4 != SCHEMA and "resume" not in SCHEMA_V4


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._shared: sqlite3.Connection | None = None
        if self.path == ":memory:":  # tests: a single shared connection
            self._shared = self._open()
        self._migrate()

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=15000")
        if self.path != ":memory:":
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _migrate(self) -> None:
        with self.tx() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                for stmt in _split_statements(SCHEMA):
                    conn.execute(stmt)
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            elif version > SCHEMA_VERSION:
                raise RuntimeError(f"Database schema v{version} is newer than this app (v{SCHEMA_VERSION}).")
            elif version < SCHEMA_VERSION:   # upgrade in place, step by step; existing rows are never touched
                if version == 1:             # v1 -> latest: the model-usage log (numbers only, no prompt text)
                    for stmt in _split_statements(USAGE_SCHEMA):
                        conn.execute(stmt)
                else:
                    if version == 2:         # v2 -> v3: remember which interview each model call was for
                        for stmt in _split_statements(USAGE_V3_ALTERS):
                            conn.execute(stmt)
                    if version <= 3:         # v3 -> v4: which provider ran it, and what a cloud call cost
                        for stmt in _split_statements(USAGE_V4_ALTERS):
                            conn.execute(stmt)
                if version <= 4:             # v4 -> v5: resumes, and where each interview question came from
                    for stmt in _split_statements(RESUME_SCHEMA + ITEMS_V5_ALTERS):
                        conn.execute(stmt)
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Write transaction (BEGIN IMMEDIATE serialises writers; commits or rolls back as a unit)."""
        conn = self._shared or self._open()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")
        finally:
            if not self._shared:
                conn.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self._shared or self._open()
        try:
            yield conn
        finally:
            if not self._shared:
                conn.close()


def _split_statements(script: str) -> list[str]:
    out, buf = [], []
    for line in script.splitlines():
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
    return out
