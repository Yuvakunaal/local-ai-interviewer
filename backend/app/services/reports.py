"""Report aggregation (deterministic), persistence and Markdown rendering.

Scoring rules (also printed in every report):
  * Question score = weighted mean of the evaluated answers on that question: the original answer counts 2,
    each follow-up answer counts 1. Rounded to 1 decimal.
  * Skipped questions and questions never reached are NOT scored: they are counted separately and are
    excluded from every average.
  * Answers that could not be evaluated (model error) are counted as 'answered, not scored' and excluded
    from averages.
  * Average score = mean of the question scores of scored questions. Topic average = mean of those within a topic.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from typing import Any, Optional

from ..db import Database, utcnow
from ..errors import not_found
from .evaluator import verdict_for

MAIN_WEIGHT, FOLLOWUP_WEIGHT = 2, 1
SCORING_RULES = [
    "Question score = weighted mean of its evaluated answers (original answer weight 2, each follow-up weight 1).",
    "Skipped and unanswered questions are never scored as zero; they are counted separately and excluded from all averages.",
    "Answers that could not be evaluated are counted as answered but excluded from averages.",
    "Basic questions (a definition or simple difference) are judged mainly on correctness, completeness and clarity; depth and real-world examples count less. A difficulty you set on a question overrides the model's guess.",
    "Average score = mean of the scored question scores. Topic scores use the same rule within each topic.",
]
UNCATEGORIZED = "Uncategorized"


def item_score(turns: list[dict]) -> Optional[float]:
    num = den = 0.0
    for t in turns:
        if t["status"] == "evaluated" and t["score"] is not None:
            w = MAIN_WEIGHT if t["kind"] == "main" else FOLLOWUP_WEIGHT
            num += w * t["score"]
            den += w
    return round(num / den, 1) if den else None


def _tok(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 2}


def _cluster(entries: list[tuple[str, int]], threshold: float = 0.5) -> list[dict[str, Any]]:
    """Group near-identical statements coming from *different* questions."""
    clusters: list[dict[str, Any]] = []
    for text, pos in entries:
        a = _tok(text)
        for cl in clusters:
            b = cl["tokens"]
            if a and b and len(a & b) / len(a | b) >= threshold:
                cl["questions"].add(pos)
                cl["tokens"] = b | a
                break
        else:
            clusters.append({"text": text, "tokens": a, "questions": {pos}})
    return clusters


SKILLS = [("correctness", "Technical correctness"), ("completeness", "Completeness"), ("depth", "Depth of understanding"),
          ("practical_application", "Practical application"), ("clarity", "Clarity & reasoning"), ("production_awareness", "Production awareness")]


def skill_averages(turns_by_question: list[list[dict]]) -> list[dict[str, Any]]:
    """Average of each dimension over every evaluated answer (main answers and follow-ups). Production awareness counts only where it applied."""
    sums: dict[str, list[float]] = {k: [] for k, _ in SKILLS}
    for ts in turns_by_question:
        for t in ts:
            ev = t.get("evaluation")
            if not ev or t.get("status") != "evaluated":
                continue
            dims = ev.get("dimension_scores") or {}
            for key, _ in SKILLS:
                if key not in dims or dims[key] is None:
                    continue
                if key == "production_awareness" and not ev.get("production_relevant"):
                    continue
                sums[key].append(float(dims[key]))
    return [{"key": k, "label": label, "average": round(sum(v) / len(v), 1) if v else None, "answers": len(v)} for (k, label), v in zip(SKILLS, sums.values())]


def build_report(c: sqlite3.Connection, iid: int) -> dict[str, Any]:
    iv = c.execute("SELECT * FROM interviews WHERE id=?", (iid,)).fetchone()
    items = [dict(r) for r in c.execute("SELECT * FROM interview_items WHERE interview_id=? ORDER BY position", (iid,))]
    turns = [dict(r) for r in c.execute("SELECT * FROM turns WHERE interview_id=? ORDER BY item_id, seq", (iid,))]
    by_item: dict[int, list[dict]] = {}
    for t in turns:
        by_item.setdefault(t["item_id"], []).append(t)

    questions = []
    for it in items:
        ts = by_item.get(it["id"], [])
        score = item_score(ts)
        tviews = []
        for t in ts:
            if t["status"] == "asked" and t["kind"] == "main" and it["status"] == "unanswered":
                continue
            tviews.append({
                "seq": t["seq"], "kind": t["kind"], "question": t["question_text"], "answer": t["answer_text"],
                "source": t["answer_source"], "status": t["status"], "score": t["score"],
                "followup_reason": t["followup_reason"],
                "evaluation": json.loads(t["evaluation_json"]) if t["evaluation_json"] else None,
            })
        q = {
            "position": it["position"] + 1, "text": it["text"], "topic": it["topic"], "difficulty": it["difficulty"],
            "status": it["status"], "score": score, "verdict": verdict_for(score) if score is not None else None,
            "followups_asked": it["followup_count"], "turns": tviews, "source": it.get("source") or "bank",
        }
        if q["source"] == "resume":
            q["resume_id"], q["resume_name"] = it.get("resume_id"), it.get("resume_name")
            q["claim"] = _load_claim(it.get("claim_json"))
        questions.append(q)

    scored = [q for q in questions if q["score"] is not None]
    unevaluated = sum(1 for q in questions if q["status"] == "answered" and q["score"] is None)
    summary = {
        "total_questions": len(items),
        "answered": sum(1 for q in questions if q["status"] == "answered"),
        "skipped": sum(1 for q in questions if q["status"] == "skipped"),
        "unanswered": sum(1 for q in questions if q["status"] == "unanswered"),
        "scored": len(scored), "answered_not_scored": unevaluated,
        "average_score": round(sum(q["score"] for q in scored) / len(scored), 1) if scored else None,
        "followups_asked": sum(q["followups_asked"] for q in questions),
    }
    summary["verdict"] = verdict_for(summary["average_score"]) if summary["average_score"] is not None else None

    topics: dict[str, list[dict]] = {}
    for q in questions:
        topics.setdefault(q["topic"] or UNCATEGORIZED, []).append(q)
    topic_rows = []
    for name, qs in topics.items():
        sc = [q["score"] for q in qs if q["score"] is not None]
        topic_rows.append({"topic": name, "questions": len(qs), "scored": len(sc),
                           "average_score": round(sum(sc) / len(sc), 1) if sc else None,
                           "question_numbers": [q["position"] for q in qs]})
    topic_rows.sort(key=lambda t: (t["average_score"] is None, t["average_score"] if t["average_score"] is not None else 0))

    out = {
        "interview": {"id": iv["id"], "title": iv["title"], "type": iv["interview_type"], "status": iv["status"],
                      "created_at": iv["created_at"], "completed_at": iv["completed_at"],
                      "config": json.loads(iv["config_json"])},
        "summary": summary, "topics": topic_rows, "questions": questions, "scoring_rules": SCORING_RULES,
        "skills": skill_averages([q["turns"] for q in questions]),
        "aggregated": rule_based_insights(questions, topic_rows, summary),
        "narrative": None,
    }
    claims = resume_claims(questions)
    if claims or any(q["source"] == "resume" for q in questions):     # older reports (no resume questions) keep exactly their old shape
        out["resume_claims"] = claims
    return out


def _load_claim(raw: Optional[str]) -> Optional[dict[str, Any]]:
    try:
        claim = json.loads(raw) if raw else None
    except ValueError:
        return None
    return claim if isinstance(claim, dict) else None


CLAIM_VERDICTS = [(7.0, "Solid"), (5.0, "Shaky"), (0.0, "Weak")]


def claim_verdict(score: float) -> str:
    return next(label for floor, label in CLAIM_VERDICTS if score >= floor)


def _claim_tip(qs: list[dict], average: float) -> str:
    """One plain sentence from what the grader already wrote (suggested improvements first, then missing points)."""
    evs = [t["evaluation"] for q in qs for t in q["turns"] if t.get("evaluation")]
    improve = next((x for e in evs for x in e.get("suggested_improvements", []) if x), None)
    missing = next((x for e in evs for x in e.get("missing_concepts", []) if x), None)
    if average >= 7:
        return "Well defended. Keep using the same concrete details, numbers and decisions."
    if improve:
        return improve.rstrip(".") + "."
    if missing:
        return f"Be more concrete about: {missing.rstrip('.')}."
    return "Prepare a specific story: your own part, a decision you made, how the result was measured and what you learned."


def resume_claims(questions: list[dict]) -> list[dict[str, Any]]:
    """Each resume claim that was defended: average of its SCORED questions (skipped / not reached never count), verdict and a tip.
    Weakest first. Computed in code; the model never decides a verdict."""
    groups: dict[tuple, list[dict]] = {}
    for q in questions:
        if q.get("source") != "resume":
            continue
        claim = q.get("claim") or {}
        key = (q.get("resume_id"), q.get("resume_name") or "", claim.get("section") or "", claim.get("label") or "")
        groups.setdefault(key, []).append(q)
    out = []
    for (rid, rname, section, label), qs in groups.items():
        scored = [q["score"] for q in qs if q["score"] is not None]
        if not scored:
            continue
        avg = round(sum(scored) / len(scored), 1)
        out.append({"resume_id": rid, "resume_name": rname, "section": section, "label": label, "average_score": avg, "verdict": claim_verdict(avg),
                    "questions": len(qs), "scored": len(scored), "question_numbers": [q["position"] for q in qs], "tip": _claim_tip(qs, avg)})
    out.sort(key=lambda c: (c["average_score"], c["label"]))
    return out


def rule_based_insights(questions: list[dict], topics: list[dict], summary: dict) -> dict[str, Any]:
    scored_topics = [t for t in topics if t["average_score"] is not None]
    strengths = [f"{t['topic']} (average {t['average_score']}/10)" for t in scored_topics if t["average_score"] >= 7][:5]
    for q in sorted((q for q in questions if q["score"] is not None and q["score"] >= 7), key=lambda q: -q["score"]):
        pts = next((t["evaluation"]["correct_points"][0] for t in q["turns"]
                    if t["evaluation"] and t["evaluation"].get("correct_points")), None)
        if pts and len(strengths) < 6:
            strengths.append(f"Q{q['position']}: {pts}")

    missing, miscon = [], []
    for q in questions:
        for t in q["turns"]:
            ev = t["evaluation"] or {}
            missing += [(m, q["position"]) for m in ev.get("missing_concepts", [])]
            miscon += [(m, q["position"]) for m in ev.get("misconceptions", [])]
    gap_clusters = sorted(_cluster(missing), key=lambda c: -len(c["questions"]))
    gaps = [(f"{c['text']}" + (f" (in {len(c['questions'])} questions)" if len(c["questions"]) > 1 else ""))
            for c in gap_clusters][:6]
    repeated = [f"{c['text']} (Q{', Q'.join(str(n) for n in sorted(c['questions']))})"
                for c in sorted(_cluster(miscon), key=lambda c: -len(c["questions"])) if len(c["questions"]) > 1][:5]

    revise = [t["topic"] for t in scored_topics if t["average_score"] < 6.5]
    if not revise and scored_topics and scored_topics[0]["average_score"] < 8:
        revise = [scored_topics[0]["topic"]]

    recs = []
    for name in revise[:4]:
        qs = [q for q in questions if (q["topic"] or UNCATEGORIZED) == name]
        want = [m for q in qs for t in q["turns"] for m in ((t["evaluation"] or {}).get("missing_concepts", []))][:2]
        recs.append(f"Revise {name}" + (f": focus on {'; '.join(want)}." if want else "."))
    if summary["skipped"] or summary["unanswered"]:
        recs.append(f"Revisit the {summary['skipped'] + summary['unanswered']} question(s) you skipped or did not reach.")
    if summary["scored"] == 0:
        recs.append("No answers were evaluated, so there is not enough evidence for a skills assessment yet.")
    elif not recs:
        recs.append("Keep practicing with harder or scenario-style questions to stay sharp.")

    if summary["average_score"] is None:
        text = "No answers were scored in this session."
    else:
        text = (f"Average {summary['average_score']}/10 across {summary['scored']} scored question(s)"
                f" ({summary['answered']} answered, {summary['skipped']} skipped, {summary['unanswered']} not reached).")
    return {"overall_summary": text, "strengths": strengths, "knowledge_gaps": gaps,
            "repeated_misconceptions": repeated, "topics_to_revise": revise, "recommendations": recs}


def narrative_digest(data: dict[str, Any]) -> Optional[str]:
    lines = []
    for q in data["questions"]:
        if q["score"] is None:
            continue
        ev = [t["evaluation"] for t in q["turns"] if t["evaluation"]]
        correct = [p for e in ev for p in e.get("correct_points", [])][:2]
        missing = [p for e in ev for p in e.get("missing_concepts", [])][:3]
        wrong = [p for e in ev for p in e.get("misconceptions", [])][:2]
        lines.append(f"Q{q['position']} [{q['topic'] or UNCATEGORIZED}] score {q['score']}/10. "
                     f"Correct: {'; '.join(correct) or '-'}. Missing: {'; '.join(missing) or '-'}. "
                     f"Misconceptions: {'; '.join(wrong) or '-'}.")
    if not lines:
        return None
    s = data["summary"]
    head = (f"Interview '{data['interview']['title']}'. {s['total_questions']} questions: {s['answered']} answered, "
            f"{s['skipped']} skipped, {s['unanswered']} not reached. Average {s['average_score']}/10.\n"
            "Topic averages: " + ", ".join(f"{t['topic']}={t['average_score']}" for t in data["topics"] if t["average_score"] is not None))
    return (head + "\n\n" + "\n".join(lines))[:6000]


# ----------------------------------------------------------------------- persistence
def store_report(c: sqlite3.Connection, iid: int) -> None:
    data = build_report(c, iid)
    now = utcnow()
    c.execute("""INSERT INTO reports(interview_id, data_json, narrative_status, created_at, updated_at)
                 VALUES (?,?, 'pending', ?, ?)
                 ON CONFLICT(interview_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at""",
              (iid, json.dumps(data, ensure_ascii=False), now, now))


def get_report(db: Database, iid: int) -> dict[str, Any]:
    with db.read() as c:
        row = c.execute("SELECT * FROM reports WHERE interview_id=?", (iid,)).fetchone()
    if not row:
        raise not_found("Report (the interview may still be running)")
    data = json.loads(row["data_json"])
    data["narrative_status"] = row["narrative_status"]
    data["narrative_error"] = row["narrative_error"]
    data["insights"] = data["narrative"] or data["aggregated"]
    data["insights_source"] = "model" if data["narrative"] else "rules"
    data["report_created_at"] = row["created_at"]
    _mark_deleted_resumes(db, data)
    return data


def _mark_deleted_resumes(db: Database, data: dict[str, Any]) -> None:
    """A report keeps working after its resume is deleted: the snapshot stays, and the UI says "(deleted resume)"."""
    ids = {q.get("resume_id") for q in data["questions"] if q.get("source") == "resume" and q.get("resume_id") is not None}
    ids |= {c.get("resume_id") for c in data.get("resume_claims") or [] if c.get("resume_id") is not None}
    if not ids:
        return
    with db.read() as c:
        alive = {r[0] for r in c.execute(f"SELECT id FROM resumes WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))}
    for q in data["questions"]:
        if q.get("source") == "resume":
            q["resume_deleted"] = q.get("resume_id") is None or q.get("resume_id") not in alive
    for cl in data.get("resume_claims") or []:
        cl["resume_deleted"] = cl.get("resume_id") is None or cl.get("resume_id") not in alive


def set_narrative(db: Database, iid: int, narrative: Optional[dict], status: str, error: Optional[str]) -> None:
    with db.tx() as c:
        row = c.execute("SELECT data_json FROM reports WHERE interview_id=?", (iid,)).fetchone()
        if not row:
            return  # interview deleted meanwhile
        data = json.loads(row["data_json"])
        if narrative is not None:
            data["narrative"] = narrative
        c.execute("UPDATE reports SET data_json=?, narrative_status=?, narrative_error=?, updated_at=? WHERE interview_id=?",
                  (json.dumps(data, ensure_ascii=False), status, error, utcnow(), iid))


# ----------------------------------------------------------------------- markdown
def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items) if items else "_None identified._"


def _md_cell(text: str) -> str:
    return str(text).replace("|", "/").replace("\n", " ")


def claim_title(c: dict[str, Any], with_section: bool = True) -> str:
    """"Resume 1 › Experience › Backend engineer at Acme" (or "(deleted resume)" when the resume is gone)."""
    claim = c.get("claim") if "claim" in c else c
    claim = claim or {}
    name = c.get("resume_name") or "Resume"
    if c.get("resume_deleted"):
        name += " (deleted resume)"
    parts = [name] + ([claim.get("section")] if with_section and claim.get("section") else []) + ([claim.get("label")] if claim.get("label") else [])
    return " › ".join(p for p in parts if p)


def render_markdown(r: dict[str, Any]) -> str:
    s, iv = r["summary"], r["interview"]
    ins = r["insights"]
    avg = f"{s['average_score']}/10 ({s['verdict']})" if s["average_score"] is not None else "n/a (no scored answers)"
    out = [f"# Interview report: {iv['title']}", "",
           f"- Type: {iv['type']}  \n- Status: {iv['status']}  \n- Started: {iv['created_at']}  \n- Finished: {iv['completed_at'] or '-'}", "",
           "## Summary", "",
           f"| Total questions | Answered | Skipped | Not reached | Scored | Average score |\n|---|---|---|---|---|---|\n"
           f"| {s['total_questions']} | {s['answered']} | {s['skipped']} | {s['unanswered']} | {s['scored']} | {avg} |", "",
           ins["overall_summary"], ""]
    out += ["### Scoring rules", "", _bullets(r["scoring_rules"]), ""]
    out += ["## Topic performance", "", "| Topic | Questions | Scored | Average |", "|---|---|---|---|"]
    for t in r["topics"]:
        out.append(f"| {t['topic']} | {t['questions']} | {t['scored']} | {t['average_score'] if t['average_score'] is not None else '-'} |")
    if r.get("resume_claims"):
        out += ["", "## Resume claims", "", "How well you defended what your resume says (weakest first).", "",
                "| Claim | Questions | Average | Verdict | Tip |", "|---|---|---|---|---|"]
        for c in r["resume_claims"]:
            out.append(f"| {_md_cell(claim_title(c))} | {', '.join(f'Q{n}' for n in c['question_numbers'])} | {c['average_score']} | {c['verdict']} | {_md_cell(c['tip'])} |")
    out += ["", "## Strengths", "", _bullets(ins["strengths"]), "", "## Knowledge gaps", "", _bullets(ins["knowledge_gaps"]), "",
            "## Repeated misconceptions", "", _bullets(ins["repeated_misconceptions"]), "",
            "## Topics to revise", "", _bullets(ins["topics_to_revise"]), "",
            "## Recommendations", "", _bullets(ins["recommendations"]), ""]
    out += ["## Scorecard", "", "| # | Question | Answer | Follow-ups | Question score |", "|---|---|---|---|---|"]
    for q in r["questions"]:
        main = next((t for t in q["turns"] if t["kind"] == "main"), None)
        ans = "skipped" if q["status"] == "skipped" else (str(main["score"]) if main and main["score"] is not None else "-")
        fus = ", ".join(f"{t['score'] if t['score'] is not None else ('skipped' if t['status'] == 'skipped' else '-')}" for t in q["turns"] if t["kind"] != "main") or "-"
        text = q["text"].replace("|", "/").replace("\n", " ")
        text = text if len(text) <= 80 else text[:79] + "…"
        out.append(f"| {q['position']} | {text} | {ans} | {fus} | {q['score'] if q['score'] is not None else q['status']} |")
    out += [f"| | **Final score** | | | **{avg}** |", ""]
    skills = [k for k in r.get("skills", []) if k["average"] is not None]
    if skills:
        out += ["## Skills", "", "| Skill | Average | Answers |", "|---|---|---|"]
        out += [f"| {k['label']} | {k['average']} | {k['answers']} |" for k in skills]
        out.append("")
    out += ["## Questions", ""]
    for q in r["questions"]:
        score = f"{q['score']}/10 ({q['verdict']})" if q["score"] is not None else q["status"]
        resume_tag = f" | Resume: {claim_title(q, with_section=False)}" if q.get("source") == "resume" else ""
        out += [f"### Q{q['position']}. {q['text']}", "",
                f"_Topic: {q['topic'] or UNCATEGORIZED} | Difficulty: {q['difficulty'] or '-'} | Result: {score}{resume_tag}_", ""]
        for t in q["turns"]:
            if t["kind"] != "main":
                out += [f"**Follow-up:** {t['question']}", ""]
            if t["status"] == "skipped":
                out += ["_Skipped._", ""]
                continue
            out += [f"**Answer:** {t['answer'] or '_(no answer)_'}", ""]
            ev = t["evaluation"]
            if ev:
                out += [f"**Score:** {t['score']}/10", ""]
                for title, key in (("Correct points", "correct_points"), ("Missing", "missing_concepts"),
                                   ("Misconceptions", "misconceptions"), ("Suggested improvements", "suggested_improvements")):
                    if ev.get(key):
                        out += [f"**{title}:**", _bullets(ev[key]), ""]
                if ev.get("ideal_answer"):
                    out += [f"**Reference answer:** {ev['ideal_answer']}", ""]
                if ev.get("uncertainty_note"):
                    out += [f"_Evaluation note ({ev.get('confidence')} confidence): {ev['uncertainty_note']}_", ""]
            elif t["status"] == "submitted":
                out += ["_Not evaluated (model error)._", ""]
    return "\n".join(x for x in out if x is not None).rstrip() + "\n"
