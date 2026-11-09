from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..schemas import (ImportCommitIn, ImportCommitOut, ImportPreviewIn, ImportPreviewOut, QuestionIn, QuestionOut,
                       ReorderIn, RubricSettings, SetIn, SetOut)

router = APIRouter(prefix="/api", tags=["library"])


def svc(request: Request):
    return request.app.state.c.questions


@router.get("/sets", response_model=list[SetOut])
def list_sets(request: Request):
    return svc(request).list_sets()


@router.post("/sets", response_model=SetOut, status_code=201)
def create_set(body: SetIn, request: Request):
    return svc(request).create_set(body.name)


@router.patch("/sets/{set_id}", response_model=SetOut)
def rename_set(set_id: int, body: SetIn, request: Request):
    return svc(request).rename_set(set_id, body.name)


@router.delete("/sets/{set_id}", status_code=200)
def delete_set(set_id: int, request: Request):
    svc(request).delete_set(set_id)
    return {"deleted": set_id}


@router.get("/sets/{set_id}/questions", response_model=list[QuestionOut])
def list_questions(set_id: int, request: Request):
    return svc(request).list_questions(set_id)


@router.post("/sets/{set_id}/questions", response_model=QuestionOut, status_code=201)
def add_question(set_id: int, body: QuestionIn, request: Request):
    return svc(request).add_question(set_id, body)


@router.put("/questions/{qid}", response_model=QuestionOut)
def update_question(qid: int, body: QuestionIn, request: Request):
    return svc(request).update_question(qid, body)


@router.delete("/questions/{qid}", status_code=200)
def delete_question(qid: int, request: Request):
    svc(request).delete_question(qid)
    return {"deleted": qid}


@router.post("/questions/{qid}/duplicate", response_model=QuestionOut, status_code=201)
def duplicate_question(qid: int, request: Request):
    return svc(request).duplicate_question(qid)


@router.post("/sets/{set_id}/reorder", response_model=list[QuestionOut])
def reorder(set_id: int, body: ReorderIn, request: Request):
    return svc(request).reorder(set_id, body.ordered_ids)


@router.post("/sets/{set_id}/import/preview", response_model=ImportPreviewOut)
def import_preview(set_id: int, body: ImportPreviewIn, request: Request):
    return svc(request).preview_import(set_id, body)


@router.post("/sets/{set_id}/import/commit", response_model=ImportCommitOut)
def import_commit(set_id: int, body: ImportCommitIn, request: Request):
    return svc(request).commit_import(set_id, body)


@router.get("/sets/{set_id}/export")
def export_set(set_id: int, request: Request):
    data = svc(request).export_set(set_id)
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in data["name"]).strip("-") or "questions"
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{safe}.json"'})


@router.get("/rubric", response_model=RubricSettings)
def get_rubric(request: Request):
    return svc(request).get_rubric()


@router.put("/rubric", response_model=RubricSettings)
def put_rubric(body: RubricSettings, request: Request):
    return svc(request).set_rubric(body)
