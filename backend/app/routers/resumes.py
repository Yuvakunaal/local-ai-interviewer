"""Resumes: upload, status, the editable content, the original PDF, and interview questions about them."""
from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from ..errors import AppError, bad_request
from ..schemas import GenerateOneIn, GenerateQuestionsIn, ResumeConsentIn, ResumePatchIn, ResumeQuestionIn

router = APIRouter(prefix="/api/resumes", tags=["resumes"])
FORM_OVERHEAD = 64 * 1024            # multipart boundaries and headers around the file


def svc(request: Request):
    return request.app.state.c.resumes


# ---------------------------------------------------------------- collection
@router.get("")
def list_resumes(request: Request) -> list[dict[str, Any]]:
    return svc(request).list()


@router.get("/storage")
def storage(request: Request) -> dict[str, Any]:
    """How many resumes, how much disk they use, the size limits and whether OCR is available (Settings, the upload dialog)."""
    return svc(request).storage()


@router.post("")
async def upload(request: Request, allow_duplicate: bool = Query(False)):
    s = request.app.state.c.settings
    max_bytes = s.resume_max_mb * 1024 * 1024
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + FORM_OVERHEAD:     # refuse before reading the body
        raise AppError(413, "resume_too_large", f"This file is larger than {s.resume_max_mb} MB. Export a smaller PDF (fewer images) and try again.")
    try:
        form = await request.form(max_files=1, max_fields=4)
    except Exception as e:  # malformed multipart, too many parts
        raise bad_request("invalid_upload", "The upload could not be read. Choose the PDF again.") from e
    try:
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise bad_request("no_file", "Choose a PDF file to upload.")
        chunks: list[bytes] = []
        size = 0
        while True:                                   # read in pieces and stop as soon as the limit is passed
            part = await file.read(256 * 1024)
            if not part:
                break
            size += len(part)
            if size > max_bytes:
                raise AppError(413, "resume_too_large", f"This file is larger than {s.resume_max_mb} MB. Export a smaller PDF (fewer images) and try again.")
            chunks.append(part)
        data = b"".join(chunks)
        status, body = await run_in_threadpool(svc(request).upload, file.filename, data, allow_duplicate=allow_duplicate)
    finally:
        await form.close()
    return JSONResponse(body, status_code=status)


@router.delete("")
def delete_all(request: Request, confirm: bool = Query(False)) -> dict[str, int]:
    if not confirm:
        raise bad_request("confirm_required", "Pass confirm=true to delete every resume.")
    return {"deleted": svc(request).delete_all()}


# ---------------------------------------------------------------- questions about resumes (static paths before /{rid})
@router.post("/questions/generate")
def generate(body: GenerateQuestionsIn, request: Request) -> dict[str, Any]:
    """Starts writing questions in the background and returns the job (state, progress; the draft questions when done). Nothing is saved."""
    return svc(request).start_generation(body)


@router.get("/questions/jobs/{job_id}")
def generation_job(job_id: str, request: Request) -> dict[str, Any]:
    return svc(request).job(job_id)


@router.delete("/questions/jobs/{job_id}")
def cancel_generation(job_id: str, request: Request) -> dict[str, Any]:
    return svc(request).cancel_job(job_id)


@router.post("/questions/generate-one")
def generate_one(body: GenerateOneIn, request: Request) -> dict[str, Any]:
    return svc(request).generate_one(body)


class SaveToBankIn(BaseModel):
    questions: list[ResumeQuestionIn] = Field(min_length=1, max_length=60)


@router.post("/questions/save-to-bank")
def save_to_bank(body: SaveToBankIn, request: Request) -> dict[str, Any]:
    return svc(request).save_to_bank(body.questions)


# ---------------------------------------------------------------- one resume
@router.get("/{rid}")
def get_resume(rid: int, request: Request) -> dict[str, Any]:
    return svc(request).get(rid)


@router.patch("/{rid}")
def patch_resume(rid: int, body: ResumePatchIn, request: Request) -> dict[str, Any]:
    return svc(request).patch(rid, body)


class RevertIn(BaseModel):
    revision: Optional[int] = None


@router.post("/{rid}/revert")
def revert(rid: int, request: Request, body: Optional[RevertIn] = None) -> dict[str, Any]:
    return svc(request).revert(rid, body.revision if body else None)


@router.post("/{rid}/reparse")
def reparse(rid: int, request: Request) -> dict[str, Any]:
    return svc(request).reparse(rid)


@router.post("/{rid}/cancel")
def cancel(rid: int, request: Request) -> dict[str, Any]:
    return svc(request).cancel(rid)


@router.post("/{rid}/consent")
def consent(rid: int, body: ResumeConsentIn, request: Request) -> dict[str, Any]:
    return svc(request).consent(rid, body.accept)


@router.delete("/{rid}")
def delete(rid: int, request: Request) -> dict[str, int]:
    svc(request).delete(rid)
    return {"deleted": rid}


@router.get("/{rid}/text")
def text(rid: int, request: Request) -> dict[str, Any]:
    return svc(request).text(rid)


def _ascii_name(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" ._") or "resume"
    return base if base.lower().endswith(".pdf") else base + ".pdf"


@router.get("/{rid}/file")
def original(rid: int, request: Request, download: bool = Query(False)) -> Response:
    """The original PDF: shown inline in the browser's own viewer, or downloaded with ?download=1."""
    path, name = svc(request).file_path(rid)
    disposition = "attachment" if download else "inline"
    headers = {"Content-Disposition": f"{disposition}; filename=\"{_ascii_name(name)}\"; filename*=UTF-8''{quote(name if name.lower().endswith('.pdf') else name + '.pdf')}",
               "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}
    return FileResponse(path, media_type="application/pdf", headers=headers)
