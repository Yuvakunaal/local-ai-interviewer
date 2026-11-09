"""The PDF report: a finished, readable document built on the server (no print dialog involved)."""
import io

import pytest
from pypdf import PdfReader

from app.services import report_pdf
from conftest import act, add_questions, answer, good_eval, start_interview, state
from test_interview_flow import always_ask


def finished(client, set_id, fake, *, n=2, answers=None, followups=0, **cfg):
    add_questions(client, set_id, n)
    if followups:
        always_ask(fake)
    st = start_interview(client, set_id, feedback_mode="at_end", max_followups=followups, **cfg)
    for text in (answers or ["An answer"] * (n + followups * n)):
        if st["status"] != "in_progress":
            break
        st = answer(client, st, text).json()
    return st


def pdf_text(content: bytes) -> str:
    return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(content)).pages)


def fetch_pdf(client, iid):
    r = client.get(f"/api/interviews/{iid}/report/export?format=pdf")
    assert r.status_code == 200, r.text
    return r


def test_the_pdf_download_is_a_real_pdf_with_a_sensible_file_name(client, set_id, fake):
    st = finished(client, set_id, fake)
    r = fetch_pdf(client, st["id"])
    assert r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF")
    cd = r.headers["content-disposition"]
    assert cd.startswith("attachment; filename=\"interview-report-t-") and cd.endswith(".pdf\"")
    assert r.headers["cache-control"] == "no-store"
    assert len(PdfReader(io.BytesIO(r.content)).pages) >= 2


def test_it_contains_the_scorecard_every_score_and_the_final_score(client, set_id, fake):
    fake.chat_replies = [good_eval(correctness=9), good_eval(correctness=5)]
    st = finished(client, set_id, fake)
    text = pdf_text(fetch_pdf(client, st["id"]).content)
    for needle in ("Interview Report", "Scorecard", "Final score", "Summary", "Detailed feedback", "Question number 1?", "Question number 2?", "Your answer", "Reference answer",
                   "Page 1 of", "How scores are calculated"):
        assert needle in text, needle
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    assert f"{rep['summary']['average_score']:g}" in text


def test_follow_ups_appear_with_their_own_scores(client, set_id, fake):
    st = finished(client, set_id, fake, n=1, followups=2, answers=["first", "second", "third"])
    rep = client.get(f"/api/interviews/{st['id']}/report").json()
    text = pdf_text(fetch_pdf(client, st["id"]).content)
    assert "Follow-up 1" in text and "Follow-up 2" in text
    assert len([t for t in rep["questions"][0]["turns"] if t["kind"] == "followup"]) == 2
    assert rep["questions"][0]["turns"][1]["question"].split()[0] in text


def test_odd_text_is_shown_literally_and_never_breaks_the_document(client, set_id, fake):
    nasty = "if a < b && c > d then <b>bold?</b> & [x]\n    indented\tcode  ✓ done — “quoted” नमस्ते \U0001F600 end"
    st = finished(client, set_id, fake, n=1, answers=[nasty])
    r = fetch_pdf(client, st["id"])
    text = pdf_text(r.content)
    assert "a < b && c > d" in text and "<b>bold?</b>" in text and "&amp;" not in text and "<br" not in text
    assert "“quoted”" in text
    assert "????" in text or "?" in text               # characters the font lacks are shown as ?, not as empty boxes


def test_a_very_long_answer_flows_over_several_pages(client, set_id, fake):
    long = " ".join(f"sentence number {i} explains idempotency in some detail." for i in range(90))
    st = finished(client, set_id, fake, n=1, answers=[long])
    pages = PdfReader(io.BytesIO(fetch_pdf(client, st["id"]).content)).pages
    assert len(pages) >= 3, len(pages)
    assert "sentence number 89" in pdf_text(fetch_pdf(client, st["id"]).content)


def test_an_interview_ended_early_with_skips_and_unreached_questions_still_renders(client, set_id, fake):
    add_questions(client, set_id, 4)
    st = start_interview(client, set_id, feedback_mode="at_end", max_followups=0)
    st = answer(client, st, "One").json()
    st = client.post(f"/api/interviews/{st['id']}/skip", json={"turn_id": st["current_turn_id"]}).json()
    client.post(f"/api/interviews/{st['id']}/end")
    text = pdf_text(fetch_pdf(client, st["id"]).content)
    assert "skipped" in text.lower() and "not reached" in text.lower() and "Question number 4?" in text


def test_an_interview_with_nothing_answered_has_a_report_too(client, set_id, fake):
    add_questions(client, set_id, 2)
    st = start_interview(client, set_id, max_followups=0)
    client.post(f"/api/interviews/{st['id']}/end")
    text = pdf_text(fetch_pdf(client, st["id"]).content)
    assert "Scorecard" in text and "No scored answers" in text


def test_unknown_interview_is_a_404(client):
    assert client.get("/api/interviews/9999/report/export?format=pdf").status_code == 404


def test_the_text_cleaner_keeps_what_the_font_can_draw_and_marks_the_rest():
    assert report_pdf.safe("Plain text, naïve café — “ok”") == "Plain text, naïve café — “ok”"
    assert report_pdf.safe("✓ yes → next") == "+ yes -> next"
    assert report_pdf.safe("a\u0000b​c") == "abc"
    assert report_pdf.safe("न") == "?" and report_pdf.safe(None) == ""
    assert report_pdf.safe("tab\there") == "tab    here"


@pytest.mark.parametrize("score, shown", [(8, "8"), (8.5, "8.5"), (7.0, "7"), (None, "-"), (0, "0")])
def test_scores_are_formatted_without_trailing_zeros(score, shown):
    assert report_pdf.fmt_score(score) == shown


def test_file_names_are_safe_for_any_title(client):
    r = {"interview": {"title": "Senior / Backend: \"SQL\" & caching?! नमस्ते", "completed_at": "2026-11-02T10:00:00+00:00", "created_at": "x"}}
    assert report_pdf.pdf_filename(r) == "interview-report-senior-backend-sql-caching-2026-11-02.pdf"
    assert report_pdf.pdf_filename({"interview": {"title": "नमस्ते", "completed_at": None, "created_at": "2026-01-05T00:00:00"}}) == "interview-report-interview-2026-01-05.pdf"
