"""Resumes: upload, the background reading job, edits, deletion, and questions about them.

Rules that keep it safe (same spirit as the interview service):
  * every state change is one SQLite transaction; edits use compare-and-set on `revision` (a stale tab gets 409 resume_changed);
  * a reading job carries a `job_id`; it can only write while the row still has that id, so a cancelled or restarted job can never
    overwrite newer state, and a deleted resume is never resurrected;
  * nothing is ever lost on failure: the PDF and whatever text was read are kept, the user can Try again or fill it in by hand;
  * model calls go through the gateway (local by default; cloud only after per-resume consent), one at a time, recorded in Model usage
    under the purposes "resume_parse" and "resume_questions" with a label such as "Resume 1" - never with resume text;
  * logs contain ids and timings only.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import Executor, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import BaseModel, model_validator

from ..config import Settings
from ..db import Database, utcnow
from ..errors import AppError, bad_request, conflict, not_found
from ..parsing import normalize_for_dedupe
from ..schemas import GenerateOneIn, GenerateQuestionsIn, QuestionIn, ResumePatchIn, ResumeProfile, ResumeQuestionIn
from . import resume_extract as rx
from .evaluator import Evaluator
from .ollama import LLMError
from .prompts import RESUME_PARSE_SYSTEM, RESUME_PROFILE_SCHEMA, RESUME_QUESTIONS_SCHEMA, resume_parse_user_prompt
from .questions import QuestionService
from .resume_profile import chunk_text, coerce_profile, is_empty, merge_profiles, skill_preview
from .resume_questions import FOCUS_KINDS, PER_CLAIM, Claim, DraftBatch, QuestionWriter, Slot, allocate, build_claims
from .usage import usage_context

log = logging.getLogger("interviewer.resumes")

WORKING = ("extracting", "ocr", "structuring")
AWAITING_CONSENT = "awaiting_cloud_consent"
PARSE_MAX_TOKENS = 1800
QUESTIONS_MAX_TOKENS = 1600
_NAME_RE = re.compile(r"^Resume (\d+)$")


def display_filename(raw: Optional[str]) -> str:
    """The user's file name, for display only: no folders, no control characters, at most 120 characters."""
    name = (raw or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip().strip(".") or "resume.pdf"
    return name[:120]


def next_resume_name(existing: list[str]) -> str:
    """"Resume N" with the lowest free N."""
    used = {int(m.group(1)) for n in existing if (m := _NAME_RE.match(n or ""))}
    n = 1
    while n in used:
        n += 1
    return f"Resume {n}"


class ProfileReply(BaseModel):
    """What the model must return for one part of a resume: a JSON object with resume fields (coerced, clamped)."""

    profile: ResumeProfile

    @model_validator(mode="before")
    @classmethod
    def _wrap(cls, v: Any) -> Any:
        if not isinstance(v, dict):
            raise ValueError("expected one JSON object")
        if not any(k in v for k in ("contact", "summary", "skills", "experience", "projects", "education", "certifications", "achievements", "other")):
            raise ValueError("the reply has none of the resume fields")
        return {"profile": coerce_profile(v)}


class ResumeService:
    def __init__(self, db: Database, settings: Settings, evaluator: Evaluator, questions: QuestionService, *,
                 executor: Optional[Executor] = None, release: Optional[Callable[[], None]] = None, is_cloud: Optional[Callable[[], bool]] = None,
                 ocr_runner: Optional[Callable[[bytes], str]] = None):
        self.db, self.settings, self.evaluator, self.questions = db, settings, evaluator, questions
        self.executor: Executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="resume")
        self.release = release or (lambda: None)
        self.is_cloud = is_cloud or (lambda: False)
        self.ocr_runner = ocr_runner                 # tests replace Tesseract with a function
        self._lock = threading.Lock()
        self._gen: dict[str, dict[str, Any]] = {}
        self.recover()

    # ================================================================ lifecycle
    def recover(self) -> None:
        """After a restart nothing stays 'reading' forever; the file and any text are kept."""
        with self.db.tx() as c:
            n = c.execute(f"""UPDATE resumes SET status='failed', error_code='interrupted', stage_detail=NULL, job_id=job_id+1, updated_at=?,
                              error_message='Interrupted – press Try again.' WHERE status IN ({','.join('?' * len(WORKING))})""", (utcnow(), *WORKING)).rowcount
        if n:
            log.info("marked %d interrupted resume job(s) as failed", n)

    def is_working(self) -> bool:
        """Is any resume being read or are questions being written? (The model must not be unloaded then.)"""
        with self._lock:
            if any(j["state"] == "running" for j in self._gen.values()):
                return True
        with self.db.read() as c:
            return bool(c.execute(f"SELECT 1 FROM resumes WHERE status IN ({','.join('?' * len(WORKING))}) LIMIT 1", WORKING).fetchone())

    # ================================================================ reading
    def _row(self, c, rid: int):
        row = c.execute("SELECT * FROM resumes WHERE id=?", (rid,)).fetchone()
        if not row:
            raise not_found("Resume")
        return row

    @staticmethod
    def _profile(raw: Optional[str]) -> Optional[ResumeProfile]:
        if not raw:
            return None
        try:
            return ResumeProfile.model_validate(json.loads(raw))
        except (ValueError, TypeError):
            return None

    def _light(self, r) -> dict[str, Any]:
        prof = self._profile(r["profile_json"])
        return {"id": r["id"], "name": r["name"], "original_filename": r["original_filename"], "size_bytes": r["size_bytes"], "pages": r["pages"],
                "status": r["status"], "stage_detail": r["stage_detail"], "error_code": r["error_code"], "error_message": r["error_message"],
                "extraction_method": r["extraction_method"], "consent_cloud": r["consent_cloud"], "revision": r["revision"],
                "created_at": r["created_at"], "updated_at": r["updated_at"], "last_parsed_at": r["last_parsed_at"],
                "has_profile": prof is not None, "skills_preview": skill_preview(prof), "warnings": len(prof.parse_warnings) if prof else 0}

    def list(self) -> list[dict[str, Any]]:
        with self.db.read() as c:
            rows = c.execute("SELECT * FROM resumes ORDER BY created_at DESC, id DESC").fetchall()
        return [self._light(r) for r in rows]

    def get(self, rid: int) -> dict[str, Any]:
        with self.db.read() as c:
            r = self._row(c, rid)
        out = self._light(r)
        prof = self._profile(r["profile_json"])
        out["profile"] = prof.model_dump() if prof else None
        out["has_ai_profile"] = bool(r["ai_profile_json"])
        out["has_text"] = bool(r["raw_text"])
        return out

    def text(self, rid: int) -> dict[str, Any]:
        with self.db.read() as c:
            r = self._row(c, rid)
        return {"id": rid, "raw_text": r["raw_text"] or "", "extraction_method": r["extraction_method"], "pages": r["pages"]}

    def file_path(self, rid: int) -> tuple[Path, str]:
        with self.db.read() as c:
            r = self._row(c, rid)
        base = self.settings.resumes_dir.resolve()
        path = (base / r["stored_name"]).resolve()
        if base not in path.parents or not path.is_file():
            raise not_found("The original PDF")
        return path, r["original_filename"]

    def storage(self) -> dict[str, Any]:
        with self.db.read() as c:
            row = c.execute("SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b, COALESCE(SUM(LENGTH(raw_text)),0) t, "
                            "COALESCE(SUM(LENGTH(profile_json)),0) + COALESCE(SUM(LENGTH(ai_profile_json)),0) p FROM resumes").fetchone()
        return {"count": row["n"], "bytes": int(row["b"]) + int(row["t"]) + int(row["p"]), "file_bytes": int(row["b"]),
                "max_mb": self.settings.resume_max_mb, "max_pages": self.settings.resume_max_pages,
                "ocr": rx.ocr_status(self.settings), "pdf_support": rx.pdf_available()}

    # ================================================================ upload
    def upload(self, filename: Optional[str], data: bytes, *, allow_duplicate: bool = False) -> tuple[int, dict[str, Any]]:
        """Validate and store a PDF, then start reading it in the background. Returns (HTTP status, body)."""
        max_bytes = self.settings.resume_max_mb * 1024 * 1024
        if not data:
            raise AppError(400, "resume_empty", "The file is empty.")
        if len(data) > max_bytes:
            raise AppError(413, "resume_too_large", f"This file is larger than {self.settings.resume_max_mb} MB. Export a smaller PDF (fewer images) and try again.")
        if not data.startswith(rx.PDF_MAGIC):
            raise AppError(415, "not_a_pdf", "This file is not a PDF. Save or export your resume as a PDF and upload that.")
        try:
            pages = rx.count_pages(data)
        except rx.PdfError as e:
            raise AppError(503 if e.code == "pdf_support_missing" else 422, e.code, e.message) from e
        if pages == 0:
            raise AppError(422, "resume_empty", "This PDF has no pages.")
        if pages > self.settings.resume_max_pages:
            raise AppError(422, "resume_too_many_pages", f"This PDF has {pages} pages; the limit is {self.settings.resume_max_pages}. Upload just your resume.")
        sha = hashlib.sha256(data).hexdigest()
        with self.db.read() as c:
            dup = c.execute("SELECT id, name FROM resumes WHERE sha256=? ORDER BY id LIMIT 1", (sha,)).fetchone()
        if dup and not allow_duplicate:
            return 200, {"duplicate_of": {"id": dup["id"], "name": dup["name"]}}
        folder = self.settings.resumes_dir
        folder.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(folder, 0o700)
        except OSError:
            pass
        stored = f"{uuid.uuid4().hex}.pdf"                 # never derived from the user's file name
        path = folder / stored
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            now = utcnow()
            with self.db.tx() as c:
                name = next_resume_name([r[0] for r in c.execute("SELECT name FROM resumes")])
                rid = c.execute("""INSERT INTO resumes(name, original_filename, stored_name, sha256, size_bytes, pages, status, stage_detail,
                                   created_at, updated_at, job_id) VALUES (?,?,?,?,?,?,'uploaded','queued',?,?,1)""",
                                (name, display_filename(filename), stored, sha, len(data), pages, now, now)).lastrowid
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        log.info("resume %s uploaded (%d bytes, %d pages)", rid, len(data), pages)
        self.executor.submit(self._run, rid, 1)
        return 202, self.get(rid)

    # ================================================================ the reading job
    def _set(self, rid: int, job_id: int, **fields: Any) -> bool:
        """Write fields only if this job is still the current one for the resume (and the resume still exists)."""
        if not fields:
            return False
        cols = ", ".join(f"{k}=?" for k in fields) + ", updated_at=?"
        with self.db.tx() as c:
            return c.execute(f"UPDATE resumes SET {cols} WHERE id=? AND job_id=?", (*fields.values(), utcnow(), rid, job_id)).rowcount > 0

    def _current(self, rid: int, job_id: int) -> bool:
        with self.db.read() as c:
            return bool(c.execute("SELECT 1 FROM resumes WHERE id=? AND job_id=?", (rid, job_id)).fetchone())

    def _begin(self, rid: int, *, status: str, detail: str, allowed: tuple[str, ...]) -> int:
        """Start a new job on this resume (bumps job_id). 409 while another job is running."""
        with self.db.tx() as c:
            r = self._row(c, rid)
            if r["status"] in WORKING:
                raise conflict("resume_busy", "This resume is being read right now. Wait for it to finish or press Stop.")
            if r["status"] not in allowed:
                raise conflict("wrong_state", "That is not possible right now. Refresh the page.")
            job = r["job_id"] + 1
            c.execute("""UPDATE resumes SET status=?, stage_detail=?, error_code=NULL, error_message=NULL, job_id=?, updated_at=? WHERE id=?""",
                      (status, detail, job, utcnow(), rid))
        return job

    def _run(self, rid: int, job_id: int) -> None:
        t0 = time.monotonic()
        try:
            self._extract(rid, job_id)
        except Exception:                                           # never leave a resume stuck in a working state
            log.exception("resume %s: unexpected failure", rid)
            self._set(rid, job_id, status="failed", stage_detail=None, error_code="internal",
                      error_message="Something went wrong while reading this resume. Your file is kept – press Try again.")
        finally:
            log.info("resume %s job %s finished in %.1fs", rid, job_id, time.monotonic() - t0)
            self._release()

    def _release(self) -> None:
        try:
            if not self.is_working():
                self.release()
        except Exception:
            log.exception("could not release the model")

    def _extract(self, rid: int, job_id: int) -> None:
        with self.db.read() as c:
            r = c.execute("SELECT stored_name FROM resumes WHERE id=? AND job_id=?", (rid, job_id)).fetchone()
        if not r:
            return
        if not self._set(rid, job_id, status="extracting", stage_detail="Reading text"):
            return
        path = self.settings.resumes_dir / r["stored_name"]
        try:
            data = path.read_bytes()
        except OSError:
            self._set(rid, job_id, status="failed", stage_detail=None, error_code="file_missing",
                      error_message="The original PDF is missing from the data folder. Delete this resume and upload it again.")
            return
        cancelled = lambda: not self._current(rid, job_id)  # noqa: E731
        progress = lambda status, detail: self._set(rid, job_id, status=status, stage_detail=detail)  # noqa: E731
        try:
            res = rx.extract_pages(data, self.settings, progress=progress, cancelled=cancelled, ocr=self.ocr_runner)
        except rx.PdfError as e:
            self._set(rid, job_id, status="failed", stage_detail=None, error_code=e.code, error_message=e.message)
            return
        if cancelled():
            return
        text, truncated = rx.clean_text(res.pages)
        base = {"raw_text": text, "pages": res.page_count, "extraction_method": res.method}
        if res.error_code:
            self._set(rid, job_id, status="failed", stage_detail=None, error_code=res.error_code, error_message=res.error_message, **base)
            log.info("resume %s: extraction stopped (%s)", rid, res.error_code)
            return
        warnings = ["Your resume is long, so only its first 24,000 characters were organised. Check the end of it."] if truncated else []
        with self.db.read() as c:
            consent = c.execute("SELECT consent_cloud FROM resumes WHERE id=?", (rid,)).fetchone()
        if self.is_cloud() and not (consent and consent[0] == 1):
            self._set(rid, job_id, status="uploaded", stage_detail=AWAITING_CONSENT, **base)
            return
        self._set(rid, job_id, **base)
        self._structure(rid, job_id, text, warnings)

    def _structure(self, rid: int, job_id: int, text: str, warnings: list[str]) -> None:
        with self.db.read() as c:
            r = c.execute("SELECT name FROM resumes WHERE id=? AND job_id=?", (rid, job_id)).fetchone()
        if not r:
            return
        chunks = chunk_text(text)
        if not chunks:
            self._set(rid, job_id, status="failed", stage_detail=None, error_code="no_text",
                      error_message="There is no text to organise. You can fill in the content yourself.")
            return
        parts: list[ResumeProfile] = []
        errors: list[str] = []
        for i, chunk in enumerate(chunks, start=1):
            if not self._set(rid, job_id, status="structuring", stage_detail=f"part {i} of {len(chunks)}"):
                return                                              # cancelled or deleted
            messages = [{"role": "system", "content": RESUME_PARSE_SYSTEM}, {"role": "user", "content": resume_parse_user_prompt(chunk, i, len(chunks))}]
            t0 = time.monotonic()
            try:
                with usage_context(None, r["name"]):
                    reply = self.evaluator.call_json(messages, RESUME_PROFILE_SCHEMA, ProfileReply, max_tokens=PARSE_MAX_TOKENS, purpose="resume_parse")
                parts.append(reply.profile)
                log.info("resume %s: part %d/%d organised in %.1fs", rid, i, len(chunks), time.monotonic() - t0)
            except LLMError as e:
                errors.append(e.message)
                log.warning("resume %s: part %d/%d failed (%s)", rid, i, len(chunks), e.code)
                if e.code in {"budget_reached", "auth_failed", "auth_missing", "no_credits", "ollama_unavailable", "model_missing"}:
                    break                                           # every other part would fail the same way
        if not self._current(rid, job_id):
            return
        merged = merge_profiles(parts) if parts else None
        if merged is None or is_empty(merged):
            reason = errors[-1] if errors else "The AI found nothing it could organise."
            self._set(rid, job_id, status="failed", stage_detail=None, error_code="structure_failed",
                      error_message=f"The AI could not organise this resume: {reason} Your file and its text are kept – press Try again, or fill it in yourself.")
            return
        if errors:
            missed = len(chunks) - len(parts)
            warnings.append(f"{missed} of {len(chunks)} part{'s' if len(chunks) != 1 else ''} of your resume could not be organised, so some content may be "
                            "missing. Compare with the Original text tab, or press Re-organise with AI.")
        merged.parse_warnings = warnings[:10]
        body = merged.model_dump_json()
        with self.db.tx() as c:
            c.execute("""UPDATE resumes SET status='ready', stage_detail=NULL, error_code=NULL, error_message=NULL, ai_profile_json=?, profile_json=?,
                         revision=revision+1, last_parsed_at=?, updated_at=? WHERE id=? AND job_id=?""", (body, body, utcnow(), utcnow(), rid, job_id))

    # ================================================================ commands
    def reparse(self, rid: int) -> dict[str, Any]:
        """Try again / Re-organise with AI: read the PDF again and replace the organised content."""
        job = self._begin(rid, status="extracting", detail="Reading text", allowed=("uploaded", "ready", "failed"))
        self.executor.submit(self._run, rid, job)
        return self.get(rid)

    def cancel(self, rid: int) -> dict[str, Any]:
        with self.db.tx() as c:
            r = self._row(c, rid)
            if r["status"] not in WORKING and not (r["status"] == "uploaded" and r["stage_detail"] in ("queued", AWAITING_CONSENT)):
                raise conflict("not_running", "Nothing is running for this resume.")
            c.execute("""UPDATE resumes SET status='failed', stage_detail=NULL, error_code='cancelled', job_id=job_id+1, updated_at=?,
                         error_message='Stopped. Your file is kept – press Try again to read it again.' WHERE id=?""", (utcnow(), rid))
        return self.get(rid)

    def consent(self, rid: int, accept: bool) -> dict[str, Any]:
        with self.db.tx() as c:
            r = self._row(c, rid)
            c.execute("UPDATE resumes SET consent_cloud=?, updated_at=? WHERE id=?", (1 if accept else 0, utcnow(), rid))
            waiting = r["status"] == "uploaded" and r["stage_detail"] == AWAITING_CONSENT
        if not accept:
            if waiting:
                with self.db.tx() as c:
                    c.execute("""UPDATE resumes SET status='failed', stage_detail=NULL, error_code='cloud_declined', job_id=job_id+1, updated_at=?,
                                 error_message='You chose not to send this resume to Ollama cloud. Switch to the local model in Settings → AI models and press Try again, or fill it in yourself.'
                                 WHERE id=?""", (utcnow(), rid))
            return self.get(rid)
        if waiting:
            job = self._begin(rid, status="structuring", detail="Starting", allowed=("uploaded",))
            self.executor.submit(self._run_structure, rid, job)
        return self.get(rid)

    def _run_structure(self, rid: int, job_id: int) -> None:
        try:
            with self.db.read() as c:
                r = c.execute("SELECT raw_text FROM resumes WHERE id=?", (rid,)).fetchone()
            self._structure(rid, job_id, (r["raw_text"] if r else "") or "", [])
        except Exception:
            log.exception("resume %s: unexpected failure", rid)
            self._set(rid, job_id, status="failed", stage_detail=None, error_code="internal",
                      error_message="Something went wrong while organising this resume. Press Try again.")
        finally:
            self._release()

    def patch(self, rid: int, body: ResumePatchIn) -> dict[str, Any]:
        if body.name is None and body.profile is None:
            raise bad_request("nothing_to_change", "Nothing to save.")
        if body.name is not None and not body.name:
            raise AppError(422, "invalid_name", "Give the resume a name.")
        with self.db.tx() as c:
            r = self._row(c, rid)
            if r["revision"] != body.revision:
                raise conflict("resume_changed", "This resume was changed in another tab or by the AI. Reload to see the latest version.", revision=r["revision"])
            if body.profile is not None and r["status"] in WORKING:
                raise conflict("resume_busy", "The AI is organising this resume right now. Wait for it to finish, or press Stop.")
            sets, args = ["revision=revision+1", "updated_at=?"], [utcnow()]
            if body.name is not None:
                sets.append("name=?")
                args.append(body.name)
            if body.profile is not None:
                sets.append("profile_json=?")
                args.append(body.profile.model_dump_json())
                if r["status"] != "ready":                       # "Fill in manually" on a resume the AI could not read
                    sets += ["status='ready'", "stage_detail=NULL", "error_code=NULL", "error_message=NULL", "job_id=job_id+1"]
            c.execute(f"UPDATE resumes SET {', '.join(sets)} WHERE id=?", (*args, rid))
        return self.get(rid)

    def revert(self, rid: int, revision: Optional[int] = None) -> dict[str, Any]:
        with self.db.tx() as c:
            r = self._row(c, rid)
            if not r["ai_profile_json"]:
                raise conflict("no_ai_version", "There is no AI version of this resume to go back to.")
            if revision is not None and r["revision"] != revision:
                raise conflict("resume_changed", "This resume was changed in another tab. Reload to see the latest version.", revision=r["revision"])
            c.execute("UPDATE resumes SET profile_json=ai_profile_json, revision=revision+1, updated_at=? WHERE id=?", (utcnow(), rid))
        return self.get(rid)

    def delete(self, rid: int) -> None:
        with self.db.tx() as c:
            r = self._row(c, rid)
            c.execute("DELETE FROM resumes WHERE id=?", (rid,))            # a running job can no longer write (its row is gone)
        self._unlink(r["stored_name"])

    def delete_all(self) -> int:
        with self.db.tx() as c:
            names = [r[0] for r in c.execute("SELECT stored_name FROM resumes")]
            c.execute("DELETE FROM resumes")
        for n in names:
            self._unlink(n)
        return len(names)

    def _unlink(self, stored: str) -> None:
        try:
            (self.settings.resumes_dir / stored).unlink(missing_ok=True)
        except OSError:
            log.warning("could not delete a resume file (it will be orphaned in data/resumes)")

    # ================================================================ questions about the resumes
    def _ready_profiles(self, ids: list[int]) -> list[tuple[int, str, ResumeProfile, Optional[int]]]:
        wanted = list(dict.fromkeys(ids))
        with self.db.read() as c:
            rows = {r["id"]: r for r in c.execute(f"SELECT * FROM resumes WHERE id IN ({','.join('?' * len(wanted))})", tuple(wanted))}
        out = []
        for i in wanted:
            r = rows.get(i)
            if not r:
                raise not_found("Resume")
            prof = self._profile(r["profile_json"])
            if r["status"] != "ready" or prof is None:
                raise conflict("resume_not_ready", f"“{r['name']}” is not ready yet. Wait until it says Ready, or open it to fix it.")
            out.append((i, r["name"], prof, r["consent_cloud"]))
        return out

    def _require_consent(self, profiles: list[tuple[int, str, ResumeProfile, Optional[int]]]) -> None:
        if not self.is_cloud():
            return
        missing = [(rid, name) for rid, name, _, consent in profiles if consent != 1]
        if missing:
            raise conflict("cloud_consent_required", "Cloud mode is on: allow sending " + ", ".join(f"“{n}”" for _, n in missing) +
                           " to Ollama cloud first.", resume_ids=[rid for rid, _ in missing])

    def _writer(self, style: str, difficulty: str, job: Optional[dict[str, Any]] = None) -> QuestionWriter:
        def call(messages: list[dict[str, str]]) -> DraftBatch:
            with usage_context(None, "Resume questions"):
                return self.evaluator.call_json(messages, RESUME_QUESTIONS_SCHEMA, DraftBatch, max_tokens=QUESTIONS_MAX_TOKENS, purpose="resume_questions")

        def progress(done: int, total: int) -> None:
            if job is not None:
                with self._lock:
                    job["done"] = done
        return QuestionWriter(call, style=style, difficulty=difficulty, progress=progress,
                              cancelled=(lambda: job is not None and job.get("cancel", False)))

    def start_generation(self, body: GenerateQuestionsIn) -> dict[str, Any]:
        profiles = self._ready_profiles(body.resume_ids)
        self._require_consent(profiles)
        claims = [build_claims(rid, name, prof) for rid, name, prof, _ in profiles]
        slots = allocate(claims, list(body.focus), body.count, body.depth)
        if not slots:
            raise AppError(422, "no_material", "There is nothing to ask about for these focus areas. Choose other focus areas, or add detail to the resume in its editor.")
        with self._lock:
            if any(j["state"] == "running" for j in self._gen.values()):
                raise conflict("generation_running", "Questions are already being written. Wait for them or press Cancel.")
            job_id = uuid.uuid4().hex[:12]
            warnings = [] if len(slots) >= body.count else [f"These resumes only have enough material for {len(slots)} question{'s' if len(slots) != 1 else ''} "
                                                            "with these settings. Add focus areas or choose a deeper level to get more."]
            job = {"id": job_id, "state": "running", "done": 0, "total": len(slots), "requested": body.count, "questions": [], "warnings": warnings,
                   "error": None, "error_code": None, "cancel": False, "started_at": utcnow()}
            self._gen[job_id] = job
            for old in sorted(self._gen, key=lambda k: self._gen[k]["started_at"])[:-10]:      # keep only the latest few
                if self._gen[old]["state"] != "running":
                    self._gen.pop(old, None)
        self.executor.submit(self._run_generation, job, slots, body)
        return self.job(job_id)

    def _run_generation(self, job: dict[str, Any], slots: list[Slot], body: GenerateQuestionsIn) -> None:
        t0 = time.monotonic()
        try:
            res = self._writer(body.style, body.difficulty, job).run(slots, exclude=list(body.exclude_texts), per_claim_cap=PER_CLAIM[body.depth])
            with self._lock:
                job["questions"] = res.questions
                job["warnings"] = job["warnings"] + [w for w in res.warnings if not job["warnings"]]
                job["state"] = "cancelled" if job["cancel"] else "done"
        except LLMError as e:
            with self._lock:
                job.update(state="error", error=e.message, error_code=e.code)
        except Exception as e:
            log.exception("question generation failed")
            with self._lock:
                job.update(state="error", error=f"Unexpected error while writing questions ({type(e).__name__}). Try again.", error_code="internal")
        finally:
            log.info("resume questions: %d of %d written in %.1fs", len(job["questions"]), job["total"], time.monotonic() - t0)
            self._release()

    def job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            j = self._gen.get(job_id)
            if not j:
                raise not_found("Question job")
            return {k: (list(v) if isinstance(v, list) else v) for k, v in j.items() if k != "cancel"}

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            j = self._gen.get(job_id)
            if not j:
                raise not_found("Question job")
            if j["state"] == "running":
                j["cancel"] = True
        return self.job(job_id)

    def generate_one(self, body: GenerateOneIn) -> dict[str, Any]:
        """Regenerate one question: the same claim, a different angle, different from every existing question."""
        profiles = self._ready_profiles([body.resume_id])
        self._require_consent(profiles)
        rid, name, prof, _ = profiles[0]
        claims = build_claims(rid, name, prof)
        claim = next((c for c in claims if c.label == body.claim.label and c.section == body.claim.section), None)
        if claim is None:                    # the resume was edited since: keep asking about what the question was about (still fenced)
            claim = Claim(f"r{rid}:x", rid, name, body.claim.section or "Resume", body.claim.label or "Resume", body.claim.excerpt or body.claim.label,
                          {"experience"})
        kinds = [body.kind] if body.kind else []
        for f in claim.focus or {"experience"}:
            kinds += FOCUS_KINDS.get(f, [])
        kinds = [k for k in dict.fromkeys(kinds) if k]
        kind = kinds[1] if len(kinds) > 1 and body.kind else kinds[0]        # a different angle from the question being replaced
        focus = next(iter(claim.focus), "experience")
        res = self._writer(body.style, body.difficulty).run([Slot(claim, kind, focus)], exclude=list(body.existing_texts), per_claim_cap=99, max_rounds=2)
        if not res.questions:
            raise AppError(422, "no_question", "The AI could not write a different question about this. Try again, or edit the question yourself.")
        return res.questions[0]

    def save_to_bank(self, questions: list[ResumeQuestionIn]) -> dict[str, Any]:
        """"Also save these to my question bank": one set per resume, named "From <resume name>", duplicates skipped."""
        by_name: dict[str, list[ResumeQuestionIn]] = {}
        for q in questions:
            by_name.setdefault(q.resume_name or "resume", []).append(q)
        added = skipped = 0
        sets = []
        for name, qs in by_name.items():
            set_name = f"From {name}"[:100]
            existing = next((s for s in self.questions.list_sets() if s["name"] == set_name), None)
            sid = existing["id"] if existing else self.questions.create_set(set_name)["id"]
            seen = {normalize_for_dedupe(q["text"]) for q in self.questions.list_questions(sid)}
            for q in qs:
                key = normalize_for_dedupe(q.text)
                if key in seen:
                    skipped += 1
                    continue
                seen.add(key)
                self.questions.add_question(sid, QuestionIn(text=q.text, rubric=q.rubric, topic=q.topic, difficulty=q.difficulty))
                added += 1
            sets.append({"id": sid, "name": set_name})
        return {"added": added, "skipped": skipped, "sets": sets}
