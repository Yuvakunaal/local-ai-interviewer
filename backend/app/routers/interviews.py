from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Query, Request, Response

from ..errors import bad_request
from ..schemas import AnswerIn, CreateInterviewIn, TurnRefIn
from ..services import reports

router = APIRouter(prefix="/api/interviews", tags=["interviews"])


def svc(request: Request):
    return request.app.state.c.interviews


@router.get("")
def list_interviews(request: Request):
    return svc(request).list()


@router.post("", status_code=201)
def create(body: CreateInterviewIn, request: Request):
    return svc(request).create(body.set_id, body.config, body.resume_questions)


@router.delete("", status_code=200)
def clear_all(request: Request, confirm: bool = Query(False)):
    if not confirm:
        raise bad_request("confirm_required", "Pass confirm=true to delete all interview history.")
    return {"deleted": svc(request).clear_all()}


@router.get("/{iid}")
def state(iid: int, request: Request):
    return svc(request).get_state(iid)


@router.delete("/{iid}", status_code=200)
def delete(iid: int, request: Request):
    svc(request).delete(iid)
    return {"deleted": iid}


@router.post("/{iid}/answer")
def answer(iid: int, body: AnswerIn, request: Request):
    return svc(request).submit_answer(iid, body)


@router.post("/{iid}/retry")
def retry(iid: int, body: TurnRefIn, request: Request):
    return svc(request).retry(iid, body.turn_id)


@router.post("/{iid}/continue")
def continue_(iid: int, body: TurnRefIn, request: Request):
    return svc(request).continue_(iid, body.turn_id)


@router.post("/{iid}/skip")
def skip(iid: int, body: TurnRefIn, request: Request):
    return svc(request).skip(iid, body.turn_id)


@router.post("/{iid}/pause")
def pause(iid: int, request: Request):
    return svc(request).pause(iid)


@router.post("/{iid}/resume")
def resume(iid: int, request: Request):
    return svc(request).resume(iid)


@router.post("/{iid}/end")
def end(iid: int, request: Request):
    return svc(request).end(iid)


@router.get("/{iid}/report")
def report(iid: int, request: Request):
    c = request.app.state.c
    data = reports.get_report(c.db, iid)
    data["ai_usage"] = c.usage.for_interview(iid)           # tokens, time and (cloud) cost of the model calls made for this interview
    return data


@router.post("/{iid}/report/regenerate")
def regenerate(iid: int, request: Request):
    return svc(request).regenerate_narrative(iid)


@router.get("/{iid}/report/export")
def export(iid: int, request: Request, format: Literal["md", "json", "pdf"] = "md"):
    data = reports.get_report(request.app.state.c.db, iid)
    name = f"interview-report-{iid}"
    if format == "pdf":
        from ..services import report_pdf
        pdf = report_pdf.render_pdf(data)
        return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{report_pdf.pdf_filename(data)}"', "Cache-Control": "no-store"})
    if format == "json":
        return Response(json.dumps(data, indent=2, ensure_ascii=False), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    return Response(reports.render_markdown(data), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}.md"'})