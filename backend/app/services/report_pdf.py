"""The interview report as a finished PDF document: a clean written report (tables and text, no charts) built on the server.

Layout: title and result strip, summary, scorecard (every answer, follow-up, question and the final score), topics, skills,
insights, then the detailed feedback for each question. Uses reportlab's bundled Bitstream Vera fonts, so it looks the same on every
computer and needs nothing installed. Characters the font does not have (some scripts, emoji) are shown as "?" rather than as empty boxes.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import Any, Iterable, Optional
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

import reportlab

# ---------------------------------------------------------------- fonts and colours
_FONT_DIR = __import__("os").path.join(__import__("os").path.dirname(reportlab.__file__), "fonts")
FONT, FONT_B, FONT_I, FONT_BI = "Vera", "Vera-Bold", "Vera-Italic", "Vera-BoldItalic"
_registered = False


def _register_fonts() -> None:
    global _registered
    if _registered:
        return
    import os
    for name, file in ((FONT, "Vera.ttf"), (FONT_B, "VeraBd.ttf"), (FONT_I, "VeraIt.ttf"), (FONT_BI, "VeraBI.ttf")):
        pdfmetrics.registerFont(TTFont(name, os.path.join(_FONT_DIR, file)))
    registerFontFamily(FONT, normal=FONT, bold=FONT_B, italic=FONT_I, boldItalic=FONT_BI)
    _registered = True


INK = colors.HexColor("#161a3a")
MUTED = colors.HexColor("#5b6183")
ACCENT = colors.HexColor("#4338d8")
SOFT = colors.HexColor("#f1f0ff")
LINE = colors.HexColor("#d9dcef")
GOOD, MID, LOW = colors.HexColor("#0f7a54"), colors.HexColor("#8f5700"), colors.HexColor("#bf3030")
QUOTE_BG = colors.HexColor("#f6f7fb")

TYPE_LABEL = {"technical": "Technical", "hr": "HR", "scenario": "Scenario-based", "mixed": "Mixed"}
DIM_LABEL = {"correctness": "Correctness", "completeness": "Completeness", "depth": "Depth", "practical_application": "Practical use",
             "clarity": "Clarity", "production_awareness": "Production"}

_REPLACE = {"✓": "+", "✔": "+", "✗": "x", "✘": "x", "✕": "x", "→": "->", "←": "<-", " ": " ", " ": " ",
            " ": " ", "​": "", "‍": "", "﻿": "", "\t": "    ", "‑": "-", "−": "-", "×": "x"}


def safe(text: Any) -> str:
    """Text the PDF font can draw: unknown characters become "?" (never an empty box), control characters disappear."""
    _register_fonts()
    have = pdfmetrics.getFont(FONT).face.charToGlyph
    out = []
    for ch in str(text if text is not None else ""):
        ch = _REPLACE.get(ch, ch)
        for c in ch:
            if c in "\n\r":
                out.append("\n")
            elif ord(c) < 32 or 0x7F <= ord(c) < 0xA0:
                continue
            elif ord(c) in have or c == " ":
                out.append(c)
            else:
                out.append("?")
    return "".join(out).replace("\r\n", "\n").replace("\r", "\n")


def para_text(text: Any) -> str:
    """Escape for reportlab's mini-markup and keep the line breaks the writer typed."""
    return escape(safe(text)).replace("\n", "<br/>")


def score_color(score: Optional[float]):
    return MUTED if score is None else GOOD if score >= 7 else MID if score >= 5 else LOW


def hexc(c) -> str:
    return "#" + c.hexval()[2:]


def fmt_score(score: Optional[float]) -> str:
    if score is None:
        return "-"
    return str(int(score)) if float(score).is_integer() else f"{score:.1f}".rstrip("0").rstrip(".")


def _date(iso: Optional[str]) -> str:
    try:
        d = datetime.fromisoformat(iso) if iso else None
    except ValueError:
        d = None
    return f"{d.day} {d:%b %Y}" if d else "-"


def _minutes(a: Optional[str], b: Optional[str]) -> Optional[int]:
    try:
        return max(1, round((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60)) if a and b else None
    except ValueError:
        return None


def pdf_filename(r: dict[str, Any]) -> str:
    title = re.sub(r"[^A-Za-z0-9]+", "-", str(r["interview"]["title"])).strip("-").lower()[:48] or "interview"
    stamp = (r["interview"].get("completed_at") or r["interview"].get("created_at") or "")[:10] or "report"
    return f"interview-report-{title}-{stamp}.pdf"


# ---------------------------------------------------------------- styles
def _styles() -> dict[str, ParagraphStyle]:
    base = dict(fontName=FONT, textColor=INK, fontSize=9.5, leading=13.8, alignment=TA_LEFT)
    s = {
        "body": ParagraphStyle("body", **base),
        "small": ParagraphStyle("small", **{**base, "fontSize": 8.2, "leading": 11.5, "textColor": MUTED}),
        "title": ParagraphStyle("title", **{**base, "fontName": FONT_B, "fontSize": 23, "leading": 27}),
        "subtitle": ParagraphStyle("subtitle", **{**base, "fontName": FONT_B, "fontSize": 12.5, "leading": 16, "spaceBefore": 4}),
        "meta": ParagraphStyle("meta", **{**base, "fontSize": 9, "textColor": MUTED, "spaceBefore": 3}),
        "h1": ParagraphStyle("h1", **{**base, "fontName": FONT_B, "fontSize": 13.5, "leading": 17, "spaceBefore": 16, "spaceAfter": 6, "textColor": ACCENT, "keepWithNext": 1}),
        "h2": ParagraphStyle("h2", **{**base, "fontName": FONT_B, "fontSize": 10.2, "leading": 14, "spaceBefore": 8, "spaceAfter": 2, "keepWithNext": 1}),
        "label": ParagraphStyle("label", **{**base, "fontName": FONT_B, "fontSize": 8.4, "leading": 11.5, "textColor": MUTED, "spaceBefore": 7, "spaceAfter": 1.5, "keepWithNext": 1}),
        "labelq": ParagraphStyle("labelq", **{**base, "fontName": FONT_B, "fontSize": 8.4, "leading": 11.5, "textColor": MUTED, "spaceBefore": 7, "spaceAfter": 6, "keepWithNext": 1}),
        "cell": ParagraphStyle("cell", **{**base, "fontSize": 9, "leading": 12.4}),
        "cellb": ParagraphStyle("cellb", **{**base, "fontName": FONT_B, "fontSize": 9, "leading": 12.4}),
        "head": ParagraphStyle("head", **{**base, "fontName": FONT_B, "fontSize": 8.4, "leading": 11, "textColor": ACCENT}),
        "quote": ParagraphStyle("quote", **{**base, "fontSize": 9.2, "leading": 13.2, "leftIndent": 9, "rightIndent": 4, "backColor": QUOTE_BG, "borderPadding": (5, 5, 5, 7)}),
        "qhead": ParagraphStyle("qhead", **{**base, "fontName": FONT_B, "fontSize": 10.5, "leading": 14.5, "backColor": SOFT, "borderPadding": (6, 8, 6, 8), "spaceBefore": 14, "spaceAfter": 6, "keepWithNext": 1}),
    }
    return s


def _bullets(items: Iterable[str], st: dict[str, ParagraphStyle], color=None) -> Optional[ListFlowable]:
    rows = [ListItem(Paragraph(para_text(x), st["body"]), leftIndent=13, bulletColor=color or MUTED) for x in items if str(x).strip()]
    if not rows:
        return None
    return ListFlowable(rows, bulletType="bullet", start="•", bulletFontName=FONT, bulletFontSize=9, leftIndent=13, bulletOffsetY=-0.5)


class _NumberedCanvas(rl_canvas.Canvas):
    """Adds "Page x of y" to every page (the total is only known at the end)."""

    def __init__(self, *args, footer: str = "", **kw):
        super().__init__(*args, **kw)
        self._pages: list[dict] = []
        self._footer = footer

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            w, _ = A4
            self.setStrokeColor(LINE); self.setLineWidth(0.5)
            self.line(18 * mm, 14 * mm, w - 18 * mm, 14 * mm)
            self.setFont(FONT, 7.8); self.setFillColor(MUTED)
            self.drawString(18 * mm, 9.5 * mm, self._footer)
            self.drawRightString(w - 18 * mm, 9.5 * mm, f"Page {self._pageNumber} of {total}")
            super().showPage()
        super().save()


# ---------------------------------------------------------------- the document
def render_pdf(r: dict[str, Any]) -> bytes:
    _register_fonts()
    st = _styles()
    iv, s, ins = r["interview"], r["summary"], r["insights"]
    width = A4[0] - 36 * mm
    story: list = []

    # ---- title block
    story.append(Paragraph("Interview Report", st["title"]))
    story.append(Paragraph(para_text(iv["title"]), st["subtitle"]))
    mins = _minutes(iv.get("created_at"), iv.get("completed_at"))
    bits = [f"{TYPE_LABEL.get(iv['type'], str(iv['type']).title())} interview", _date(iv.get("created_at")),
            f"{s['total_questions']} question{'' if s['total_questions'] == 1 else 's'}"]
    if mins:
        bits.append(f"{mins} min")
    bits.append(str(iv["status"]).replace("_", " "))
    story.append(Paragraph(para_text("  |  ".join(bits)), st["meta"]))
    story.append(Spacer(1, 10))

    # ---- result strip
    avg = s.get("average_score")
    big = ParagraphStyle("big", fontName=FONT_B, fontSize=26, leading=30, textColor=score_color(avg))
    verdict = ParagraphStyle("verd", fontName=FONT_B, fontSize=10, leading=13, textColor=score_color(avg))
    num = ParagraphStyle("num", fontName=FONT_B, fontSize=17, leading=21, textColor=INK, alignment=1)
    lab = ParagraphStyle("lab", fontName=FONT, fontSize=7.8, leading=10, textColor=MUTED, alignment=1)
    score_cell = [Paragraph(f"{fmt_score(avg)}<font size=11 color='{hexc(MUTED)}'> / 10</font>" if avg is not None else "-", big),
                  Paragraph(para_text(s.get("verdict") or "No scored answers"), verdict)]
    cells = [(str(s["answered"]), "Answered"), (str(s["skipped"]), "Skipped"), (str(s["unanswered"]), "Not reached"), (str(s["followups_asked"]), "Follow-ups")]
    strip = Table([[score_cell] + [[Paragraph(n, num), Paragraph(l, lab)] for n, l in cells]],
                  colWidths=[width * 0.28] + [width * 0.18] * 4)
    strip.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                               ("LINEBEFORE", (1, 0), (-1, -1), 0.5, LINE), ("TOPPADDING", (0, 0), (-1, -1), 11), ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
                               ("LEFTPADDING", (0, 0), (0, 0), 14)]))
    story.append(strip)

    # ---- summary
    story.append(Paragraph("Summary", st["h1"]))
    story.append(Paragraph(para_text(ins.get("overall_summary") or "No summary available."), st["body"]))
    if s.get("answered_not_scored"):
        story.append(Spacer(1, 4))
        story.append(Paragraph(para_text(f"{s['answered_not_scored']} answered question(s) could not be evaluated and are left out of the average."), st["small"]))

    # ---- scorecard
    story.append(Paragraph("Scorecard", st["h1"]))
    head = [Paragraph(h, st["head"]) for h in ("#", "Question", "Answer", "Follow-ups", "Score")]
    rows = [head]
    for q in r["questions"]:
        turns = q["turns"]
        main = next((t for t in turns if t["kind"] == "main"), None)
        if q["status"] == "skipped":
            ans = "skipped"
        elif q["status"] == "unanswered" or main is None:
            ans = "not reached"
        else:
            ans = fmt_score(main["score"]) if main["score"] is not None else "not scored"
        fus = []
        for t in (x for x in turns if x["kind"] != "main"):
            fus.append("skipped" if t["status"] == "skipped" else (fmt_score(t["score"]) if t["score"] is not None else "-"))
        qtext = para_text(q["text"] if len(q["text"]) <= 260 else q["text"][:259] + "…")
        topic = f"<br/><font size=7.6 color='{hexc(MUTED)}'>{para_text(q['topic'] or 'Uncategorized')}{'  |  Resume' if q.get('source') == 'resume' else ''}</font>"
        total = f"<font name='{FONT_B}' size=11 color='{hexc(score_color(q['score']))}'>{fmt_score(q['score'])}</font>" if q["score"] is not None else \
            f"<font color='{hexc(MUTED)}'>{'skipped' if q['status'] == 'skipped' else 'not reached' if q['status'] == 'unanswered' else 'not scored'}</font>"
        sub = f"<br/><font size=7.6 color='{hexc(MUTED)}'>{para_text(q['verdict'])}</font>" if q["score"] is not None and q.get("verdict") else ""
        rows.append([Paragraph(f"Q{q['position']}", st["cellb"]), Paragraph(qtext + topic, st["cell"]), Paragraph(para_text(ans), st["cell"]),
                     Paragraph(para_text(", ".join(fus) if fus else "-"), st["cell"]), Paragraph(total + sub, st["cell"])])
    final_label = Paragraph("Final score", ParagraphStyle("fl", fontName=FONT_B, fontSize=10.5, leading=14, textColor=INK))
    final_val = Paragraph(f"<font name='{FONT_B}' size=13 color='{hexc(score_color(avg))}'>{fmt_score(avg)}</font><font size=8 color='{hexc(MUTED)}'> / 10</font>"
                          f"<br/><font size=7.6 color='{hexc(MUTED)}'>{para_text(s.get('verdict') or '')}</font>", st["cell"])
    rows.append([final_label, "", "", "", final_val])
    sc = Table(rows, colWidths=[11 * mm, width - 11 * mm - 24 * mm - 26 * mm - 24 * mm, 24 * mm, 26 * mm, 24 * mm], repeatRows=1)
    last = len(rows) - 1
    sc.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), SOFT), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
                            ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("SPAN", (0, last), (3, last)),
                            ("BACKGROUND", (0, last), (-1, last), SOFT), ("LINEABOVE", (0, last), (-1, last), 0.8, LINE), ("VALIGN", (0, last), (-1, last), "MIDDLE")]))
    story.append(sc)
    story.append(Paragraph("A question's score is the weighted average of its answers: the main answer counts twice and each follow-up once.", st["small"]))

    # ---- topics and skills (small tables)
    topics = [t for t in r.get("topics", [])]
    if topics:
        story.append(Paragraph("Topic performance", st["h1"]))
        trows = [[Paragraph(h, st["head"]) for h in ("Topic", "Questions", "Average")]]
        for t in topics:
            trows.append([Paragraph(para_text(t["topic"]), st["cell"]), Paragraph(str(t["questions"]), st["cell"]),
                          Paragraph(f"<font name='{FONT_B}' color='{hexc(score_color(t['average_score']))}'>{fmt_score(t['average_score'])}</font>", st["cell"])])
        tt = Table(trows, colWidths=[width - 60 * mm, 30 * mm, 30 * mm], repeatRows=1)
        tt.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), SOFT), ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story.append(tt)
    claims = r.get("resume_claims") or []
    if claims:
        from .reports import claim_title
        story.append(Paragraph("Resume claims", st["h1"]))
        story.append(Paragraph("How well you defended what your resume says, weakest first. Solid 7+, shaky 5-7, weak below 5.", st["small"]))
        crows = [[Paragraph(h, st["head"]) for h in ("Claim", "Average", "Verdict")]]
        for c in claims:
            crows.append([Paragraph(para_text(claim_title(c)) + f"<br/><font size=7.6 color='{hexc(MUTED)}'>{para_text(c['tip'])}</font>", st["cell"]),
                          Paragraph(f"<font name='{FONT_B}' color='{hexc(score_color(c['average_score']))}'>{fmt_score(c['average_score'])}</font>", st["cell"]),
                          Paragraph(f"<font color='{hexc(score_color(c['average_score']))}'>{para_text(c['verdict'])}</font>", st["cell"])])
        ct = Table(crows, colWidths=[width - 50 * mm, 25 * mm, 25 * mm], repeatRows=1)
        ct.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), SOFT), ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story.append(ct)
    skills = [k for k in r.get("skills", []) if k.get("average") is not None]
    if skills:
        story.append(Paragraph("Skills", st["h1"]))
        krows = [[Paragraph(h, st["head"]) for h in ("Skill", "Average", "Answers rated")]]
        for k in skills:
            krows.append([Paragraph(para_text(k["label"]), st["cell"]),
                          Paragraph(f"<font name='{FONT_B}' color='{hexc(score_color(k['average']))}'>{fmt_score(k['average'])}</font>", st["cell"]), Paragraph(str(k["answers"]), st["cell"])])
        kt = Table(krows, colWidths=[width - 60 * mm, 30 * mm, 30 * mm], repeatRows=1)
        kt.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), SOFT), ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story.append(kt)

    # ---- insights
    blocks = [("Strengths", ins.get("strengths"), GOOD), ("Knowledge gaps", ins.get("knowledge_gaps"), MID), ("Repeated misconceptions", ins.get("repeated_misconceptions"), LOW),
              ("Topics to revise", ins.get("topics_to_revise"), ACCENT), ("Recommendations", ins.get("recommendations"), ACCENT)]
    shown = [(t, items, c) for t, items, c in blocks if items]
    if shown:
        story.append(Paragraph("Insights", st["h1"]))
        for title, items, c in shown:
            lst = _bullets(items, st, c)
            if lst:
                story.append(KeepTogether([Paragraph(title, st["h2"]), lst]))

    # ---- detailed feedback
    story.append(Paragraph("Detailed feedback", st["h1"]))
    story.append(Paragraph("Each question with your answers, how they were rated and a reference answer.", st["small"]))
    for q in r["questions"]:
        score_txt = f"{fmt_score(q['score'])}/10" + (f" ({q['verdict']})" if q.get("verdict") else "") if q["score"] is not None else \
            ("skipped" if q["status"] == "skipped" else "not reached" if q["status"] == "unanswered" else "not scored")
        meta = " | ".join(x for x in (q["topic"] or "Uncategorized", f"{q['difficulty']}" if q.get("difficulty") else None, score_txt,
                                      "From your resume" if q.get("source") == "resume" else None) if x)
        story.append(Paragraph(f"Q{q['position']}  <font name='{FONT}' size=8.6 color='{hexc(MUTED)}'>{para_text(meta)}</font>", st["qhead"]))
        story.append(Paragraph(para_text(q["text"]), st["body"]))
        if not q["turns"]:
            story.append(Paragraph("This question was not reached.", st["small"]))
        followup_no = 0
        for t in q["turns"]:
            if t["kind"] == "followup":
                followup_no += 1
                story.append(Paragraph(f"Follow-up {followup_no}", st["label"]))
                story.append(Paragraph(para_text(t["question"]), st["body"]))
            if t["status"] == "skipped":
                story.append(Paragraph("Skipped, not scored.", st["small"]))
                continue
            if t["status"] == "asked":
                story.append(Paragraph("Not answered.", st["small"]))
                continue
            story.append(Paragraph("Your answer" + (" (spoken)" if t.get("source") == "voice" else ""), st["labelq"]))
            story.append(Paragraph(para_text(t["answer"] or "(no answer)"), st["quote"]))
            ev = t.get("evaluation")
            if not ev:
                story.append(Paragraph("Not evaluated (the model had a problem).", st["small"]))
                continue
            sc_txt = f"Score {fmt_score(t['score'])}/10" if t["score"] is not None else "Score -"
            note = f" - {ev['verdict_summary']}" if ev.get("verdict_summary") else ""
            story.append(Paragraph(f"<font name='{FONT_B}' color='{hexc(score_color(t['score']))}'>{para_text(sc_txt)}</font>{para_text(note)}", ParagraphStyle("sc", parent=st["body"], spaceBefore=6)))
            dims = ev.get("dimension_scores") or {}
            if dims:
                line = "   ".join(f"{DIM_LABEL.get(k, k)} {fmt_score(v)}" for k, v in dims.items() if v is not None and (k != "production_awareness" or ev.get("production_relevant")))
                story.append(Paragraph(para_text(line), st["small"]))
            for title, key, color in (("What you did well", "correct_points", GOOD), ("What was missing", "missing_concepts", MID),
                                      ("Misconceptions", "misconceptions", LOW), ("How to improve", "suggested_improvements", ACCENT)):
                lst = _bullets(ev.get(key) or [], st, color)
                if lst:
                    story.append(Paragraph(title, st["label"]))
                    story.append(lst)
            if ev.get("ideal_answer"):
                story.append(Paragraph("Reference answer", st["label"]))
                story.append(Paragraph(para_text(ev["ideal_answer"]), st["body"]))
            extras = []
            if ev.get("uncertainty_note"):
                extras.append(f"Evaluation note ({ev.get('confidence', 'medium')} confidence): {ev['uncertainty_note']}")
            gb = ev.get("graded_by")
            if gb and gb.get("model"):
                extras.append(f"Graded by {gb['model']} ({'Ollama cloud' if gb.get('provider') == 'cloud' else 'on this computer'})")
            if extras:
                story.append(Spacer(1, 3))
                story.append(Paragraph(para_text(" | ".join(extras)), st["small"]))

    # ---- how scores are calculated + disclaimer
    rules = r.get("scoring_rules") or []
    if rules:
        story.append(Paragraph("How scores are calculated", st["h1"]))
        lst = _bullets(rules, st)
        if lst:
            story.append(lst)
    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", thickness=0.5, color=LINE))
    story.append(Paragraph("Scores and feedback are produced by an AI model and are meant as study guidance, not as a verdict. Without a reference answer for a question, the "
                           "model relies on general knowledge and can be wrong.", st["small"]))

    buf = io.BytesIO()
    footer = f"AI Interviewer  |  {safe(iv['title'])[:60]}  |  {_date(iv.get('completed_at') or iv.get('created_at'))}"
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=20 * mm,
                            title=f"Interview report: {safe(iv['title'])}", author="AI Interviewer", subject="Mock interview report")
    doc.build(story, canvasmaker=lambda *a, **k: _NumberedCanvas(*a, footer=footer, **k))
    return buf.getvalue()
