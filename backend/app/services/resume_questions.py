"""Interview questions about the candidate's own resume.

The CODE decides what is asked: it turns the saved (edited) profile into claims, allocates them across the chosen focus areas and resumes,
and enforces the count, the per-claim cap, uniqueness, length, difficulty and that every question is about its claim. The MODEL only writes
the wording, for at most four claims per request (small context), and never sees more than one ~400-character excerpt per claim.
If the model under-delivers the code asks again in small top-up requests; if it still falls short it returns what it has with a warning.
It never fabricates a question.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Optional

from pydantic import BaseModel, field_validator

from ..schemas import ResumeProfile
from .evaluator import too_similar
from .ollama import LLMError
from .prompts import (CLAIM_EXCERPT_CHARS, RESUME_QUESTION_KINDS, RESUME_QUESTIONS_SCHEMA, resume_questions_system,
                      resume_questions_user_prompt)

log = logging.getLogger("interviewer.resume_questions")

FOCUS_KINDS: dict[str, list[str]] = {
    "experience": ["project_deep_dive", "decision_tradeoff", "failure_learning"],
    "projects": ["project_deep_dive", "decision_tradeoff", "failure_learning"],
    "skills": ["tech_depth", "decision_tradeoff", "failure_learning"],
    "achievements": ["metric_challenge", "project_deep_dive", "decision_tradeoff"],
    "education": ["project_deep_dive", "tech_depth", "decision_tradeoff"],
    "behavioural": ["ownership_behavioural", "failure_learning", "decision_tradeoff"],
    "gaps": ["gap_transition", "ownership_behavioural", "decision_tradeoff"],
}
SECTION_FOR_FOCUS = {"experience": "Experience", "projects": "Projects", "skills": "Skills", "achievements": "Achievements", "education": "Education",
                     "behavioural": "Experience", "gaps": "Career"}
PER_CLAIM = {"overview": 1, "standard": 2, "deep": 3}          # most questions one claim may get
CLAIMS_PER_REQUEST = 4
MIN_Q, MAX_Q = 20, 400
METRIC_RE = re.compile(r"(\d[\d,.]*\s*(%|percent|x\b|×|k\b|m\b|million|billion|ms\b|seconds?|hours?|users?|customers?|requests?|qps|rps|tps))|"
                       r"([$€£₹]\s?\d)|(\b\d{2,}[\d,.]*\+?\s*(users|customers|clients|engineers|people|teams?|services|countries|stores)\b)", re.I)
YES_NO_RE = re.compile(r"^\s*(did|do|does|is|are|was|were|have|has|had|will|would you agree)\b", re.I)
STOP = {"with", "from", "that", "this", "your", "you", "and", "for", "the", "about", "what", "how", "when", "which", "while", "into", "were", "was",
        "have", "has", "had", "they", "them", "their", "there", "where", "why", "would", "could", "should", "walk", "through", "tell", "describe",
        "explain", "role", "team", "work", "worked", "working", "using", "used", "make", "made", "more", "most", "some", "time", "also", "over"}


@dataclass
class Claim:
    ref: str                         # stable id within one generation, e.g. "r3:exp:0:1"
    resume_id: int
    resume_name: str
    section: str                     # Experience | Projects | Skills | Education | Achievements | Career | Summary
    label: str
    excerpt: str
    focus: set[str] = field(default_factory=set)
    has_metric: bool = False

    def public(self) -> dict[str, str]:
        return {"section": self.section, "label": self.label, "excerpt": self.excerpt}


def _clip(text: str, n: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _dates(e) -> str:
    return " – ".join(x for x in (e.start, "present" if e.is_current and not e.end else e.end) if x)


_YEAR = re.compile(r"(19|20)\d{2}")
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def parse_when(text: str) -> Optional[date]:
    """"Mar 2021", "2021-03", "03/2021", "2021" -> a date (first of the month); "present" -> None."""
    t = (text or "").lower()
    y = _YEAR.search(t)
    if not y:
        return None
    month = next((i for m, i in _MONTHS.items() if m in t), None)
    if month is None:
        m = re.search(r"\b(0?[1-9]|1[0-2])\s*[/.-]\s*(19|20)\d{2}|(19|20)\d{2}\s*[/.-]\s*(0?[1-9]|1[0-2])\b", t)
        if m:
            month = int(m.group(1) or m.group(4))
    return date(int(y.group(0)), month or 1, 1)


def build_claims(resume_id: int, resume_name: str, profile: ResumeProfile) -> list[Claim]:
    """Every claim in one resume an interviewer could ask about, with the focus areas it serves."""
    claims: list[Claim] = []
    rid = resume_id

    def add(ref: str, section: str, label: str, excerpt: str, focus: set[str], metric: bool = False) -> None:
        if label.strip() and excerpt.strip():
            claims.append(Claim(f"r{rid}:{ref}", rid, resume_name, section, _clip(label, 200), _clip(excerpt, CLAIM_EXCERPT_CHARS), focus, metric))

    for i, e in enumerate(profile.experience):
        role = " at ".join(x for x in (e.title, e.company) if x) or "A role"
        head = ", ".join(x for x in (role, e.location, _dates(e)) if x)
        bullets = e.bullets or []
        clusters = [bullets[k:k + 3] for k in range(0, len(bullets), 3)] or [[]]
        for k, cl in enumerate(clusters[:4]):
            label = role if len(clusters) == 1 else f"{role}: {_clip(cl[0], 60)}"     # several bullet groups: each named by its first bullet
            metric = any(METRIC_RE.search(b) for b in cl)
            add(f"exp:{i}:{k}", "Experience", label, head + (": " + " • ".join(cl) if cl else ""), {"experience", "behavioural"}, metric)
        for k, b in enumerate(bullets):
            if METRIC_RE.search(b):
                add(f"expm:{i}:{k}", "Experience", f"{role}: {_clip(b, 90)}", f"{head}: {b}", {"achievements"}, True)
    for i, pr in enumerate(profile.projects):
        name = pr.name or "A project"
        meta = ", ".join(x for x in (f"role: {pr.role}" if pr.role else "", f"tech: {', '.join(pr.tech)}" if pr.tech else "") if x)
        metric = any(METRIC_RE.search(b) for b in pr.bullets)
        add(f"prj:{i}", "Projects", name, f"{name}{' (' + meta + ')' if meta else ''}: " + " • ".join(pr.bullets[:4]), {"projects", "behavioural"} | ({"skills"} if pr.tech else set()), metric)
        for k, b in enumerate(pr.bullets):
            if METRIC_RE.search(b):
                add(f"prjm:{i}:{k}", "Projects", f"{name}: {_clip(b, 90)}", f"{name}: {b}", {"achievements"}, True)
    for i, g in enumerate(profile.skills):
        if g.items:
            add(f"skl:{i}", "Skills", f"{g.group or 'Skills'}: {', '.join(g.items[:6])}", f"{g.group or 'Skills'}: {', '.join(g.items)}", {"skills"})
    for i, ed in enumerate(profile.education):
        label = ", ".join(x for x in (ed.degree, ed.field) if x) or ed.school
        add(f"edu:{i}", "Education", f"{label}{' at ' + ed.school if ed.school and label != ed.school else ''}",
            ", ".join(x for x in (ed.degree, ed.field, ed.school, " – ".join(y for y in (ed.start, ed.end) if y), ed.details) if x), {"education"})
    for i, a in enumerate(profile.achievements):
        add(f"ach:{i}", "Achievements", _clip(a, 120), a, {"achievements"}, bool(METRIC_RE.search(a)))
    for i, cert in enumerate(profile.certifications):
        add(f"crt:{i}", "Certifications", _clip(cert, 120), cert, {"achievements", "education"})
    # gaps and transitions between consecutive roles (most recent first on a resume, but compare by date when dates exist)
    roles = [e for e in profile.experience if e.company or e.title]
    for i in range(len(roles) - 1):
        a, b = roles[i], roles[i + 1]
        newer, older = (a, b)
        na, ob = parse_when(newer.start), parse_when(older.end) if older.end and "present" not in older.end.lower() else None
        if na and ob and ob > na:
            newer, older = b, a
            na, ob = parse_when(newer.start), parse_when(older.end)
        older_label = " at ".join(x for x in (older.title, older.company) if x)
        newer_label = " at ".join(x for x in (newer.title, newer.company) if x)
        if na and ob and (na.year * 12 + na.month) - (ob.year * 12 + ob.month) >= 6:
            months = (na.year * 12 + na.month) - (ob.year * 12 + ob.month)
            add(f"gap:{i}", "Career", f"Gap between {older.company or older.title} and {newer.company or newer.title}",
                f"{older_label} ended {older.end}; {newer_label} started {newer.start} (about {months} months later).", {"gaps"})
        else:
            add(f"trn:{i}", "Career", f"Move from {older.company or older.title} to {newer.company or newer.title}",
                f"From {older_label} ({_dates(older)}) to {newer_label} ({_dates(newer)}).", {"gaps"})
    if profile.summary and not claims:
        add("sum", "Summary", "Professional summary", profile.summary, {"experience", "behavioural"})
    return claims


# ---------------------------------------------------------------- allocation (pure, deterministic)
@dataclass
class Slot:
    claim: Claim
    kind: str
    focus: str


def allocate(claims_by_resume: list[list[Claim]], focus: list[str], count: int, depth: str) -> list[Slot]:
    """Choose which claim each question is about and what kind of question it is.

    Round-robin over the focus areas (in the user's order) and, inside each area, over the resumes, taking each resume's claims in order.
    Overview and standard depth give each claim one question per round; standard allows a second round (at most 2 per claim) when the claims
    run out; deep-dive asks up to 3 questions about the same claim in a row (different kinds)."""
    cap = PER_CLAIM.get(depth, 2)
    used: dict[str, int] = {}
    slots: list[Slot] = []
    focus = [f for f in dict.fromkeys(focus) if f in FOCUS_KINDS] or ["experience"]
    pools = {f: [[c for c in claims if f in c.focus] for claims in claims_by_resume] for f in focus}
    cursor = {f: [0] * len(claims_by_resume) for f in focus}
    rounds = 1 if depth == "overview" else (cap if depth == "standard" else 1)
    for rnd in range(rounds):
        progressed = True
        while len(slots) < count and progressed:
            progressed = False
            for f in focus:
                for r, pool in enumerate(pools[f]):
                    if len(slots) >= count:
                        break
                    while cursor[f][r] < len(pool):
                        c = pool[cursor[f][r]]
                        cursor[f][r] += 1
                        if used.get(c.ref, 0) > rnd:
                            continue
                        per = min(cap, count - len(slots)) if depth == "deep" else 1
                        start = used.get(c.ref, 0)
                        for k in range(per):
                            slots.append(Slot(c, FOCUS_KINDS[f][(start + k) % len(FOCUS_KINDS[f])], f))
                        used[c.ref] = start + per
                        progressed = True
                        break
        if len(slots) >= count:
            break
        cursor = {f: [0] * len(claims_by_resume) for f in focus}         # next round: the same claims again, a different kind
    return slots[:count]


# ---------------------------------------------------------------- validating what the model wrote
class DraftQ(BaseModel):
    claim_ref: str = ""
    kind: str = ""
    text: str = ""
    rubric: str = ""
    topic: str = ""
    difficulty: str = ""

    @field_validator("claim_ref", "kind", "text", "rubric", "topic", "difficulty", mode="before")
    @classmethod
    def _s(cls, v: Any) -> str:
        return re.sub(r"[ \t]+", " ", str(v if v is not None else "")).strip()


class DraftBatch(BaseModel):
    questions: list[DraftQ] = []

    @field_validator("questions", mode="before")
    @classmethod
    def _q(cls, v: Any) -> Any:
        return [x for x in v if isinstance(x, dict)][:20] if isinstance(v, list) else []


def _content_tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]", (text or "").lower()) if (len(t) > 3 or any(ch.isdigit() for ch in t)) and t not in STOP}


def references_claim(text: str, claim: Claim) -> bool:
    """The question must mention something specific to its claim (a name, technology, company or number from it)."""
    return bool(_content_tokens(text) & _content_tokens(claim.label + " " + claim.excerpt))


def acceptable_text(text: str) -> Optional[str]:
    """Why a question is rejected, or None if it is fine."""
    if not MIN_Q <= len(text) <= MAX_Q:
        return "length"
    if YES_NO_RE.match(text):
        return "yes/no"
    return None


DIFFS = ["easy", "medium", "hard"]


@dataclass
class GenResult:
    questions: list[dict[str, Any]]
    warnings: list[str]


class QuestionWriter:
    """Runs the requests for one generation. `call(messages) -> DraftBatch` is the validated model call (raises LLMError)."""

    def __init__(self, call: Callable[[list[dict[str, str]]], DraftBatch], *, style: str, difficulty: str,
                 cancelled: Callable[[], bool] = lambda: False, progress: Callable[[int, int], None] = lambda done, total: None):
        self.call, self.style, self.difficulty = call, style, difficulty
        self.cancelled, self.progress = cancelled, progress

    def _difficulty(self, model_value: str, n: int) -> str:
        if self.difficulty != "mixed":
            return self.difficulty
        v = model_value.lower()
        return v if v in DIFFS else DIFFS[n % 3]

    def _request(self, batch: list[tuple[Claim, list[Slot]]], avoid: list[str]) -> DraftBatch:
        spec = [{"ref": f"C{i + 1}", "section": c.section, "label": c.label, "excerpt": c.excerpt, "kinds": [s.kind for s in slots]}
                for i, (c, slots) in enumerate(batch)]
        messages = [{"role": "system", "content": resume_questions_system(self.style)},
                    {"role": "user", "content": resume_questions_user_prompt(spec, self.difficulty, avoid)}]
        return self.call(messages)

    def run(self, slots: list[Slot], *, exclude: list[str], per_claim_cap: int, max_rounds: int = 3) -> GenResult:
        """Fill every slot with a valid, distinct question (or report how many could not be written)."""
        accepted: list[dict[str, Any]] = []
        per_claim: dict[str, int] = {}
        order = {id(s): i for i, s in enumerate(slots)}
        pending = list(slots)
        total = len(slots)
        failures = 0
        errors: list[str] = []
        for rnd in range(max_rounds):
            if not pending or self.cancelled():
                break
            groups: dict[str, tuple[Claim, list[Slot]]] = {}
            for s in pending:
                groups.setdefault(s.claim.ref, (s.claim, []))[1].append(s)
            batches = [list(groups.values())[i:i + CLAIMS_PER_REQUEST] for i in range(0, len(groups), CLAIMS_PER_REQUEST)]
            still: list[Slot] = []
            for batch in batches:
                if self.cancelled():
                    break
                refs = {f"C{i + 1}": (c, sl) for i, (c, sl) in enumerate(batch)}
                try:
                    out = self._request(batch, exclude + [q["text"] for q in accepted])
                except LLMError as e:
                    failures += 1
                    errors.append(e.message)
                    still += [s for _, sl in batch for s in sl]
                    continue
                wanted = {ref: list(sl) for ref, (_, sl) in refs.items()}
                for d in out.questions:
                    num = re.search(r"\d+", d.claim_ref or "")
                    ref = f"C{num.group(0)}" if num else ("C1" if len(refs) == 1 else "")
                    if ref not in refs or not wanted.get(ref):
                        continue
                    claim, _ = refs[ref]
                    slot = next((s for s in wanted[ref] if s.kind == d.kind), wanted[ref][0])
                    text = d.text
                    if acceptable_text(text) or not references_claim(text, claim):
                        continue
                    if per_claim.get(claim.ref, 0) >= per_claim_cap:
                        continue
                    if too_similar(text, exclude + [q["text"] for q in accepted]):        # the same duplicate rule as follow-ups
                        continue
                    wanted[ref].remove(slot)
                    per_claim[claim.ref] = per_claim.get(claim.ref, 0) + 1
                    accepted.append({"text": text, "rubric": d.rubric[:1500] or None, "topic": (d.topic[:80] or claim.section),
                                     "difficulty": self._difficulty(d.difficulty, len(accepted)),
                                     "kind": slot.kind if d.kind not in RESUME_QUESTION_KINDS else d.kind,
                                     "resume_id": claim.resume_id, "resume_name": claim.resume_name, "claim": claim.public(), "focus": slot.focus,
                                     "_order": order[id(slot)]})
                    self.progress(len(accepted), total)
                    if len(accepted) >= total:
                        break
                still += [s for sl in wanted.values() for s in sl]
                if len(accepted) >= total:
                    break
            pending = still if len(accepted) < total else []
        warnings: list[str] = []
        if len(accepted) < total and not self.cancelled():
            if failures and not accepted:
                raise LLMError("generation_failed", errors[-1] if errors else "The AI could not write questions. Try again.")
            warnings.append(f"Only {len(accepted)} of {total} questions could be written for these settings. "
                            "Try more focus areas, another resume, or press Regenerate.")
        accepted.sort(key=lambda q: q.pop("_order"))     # the planned order (claims interleaved as allocated), not the model's order
        return GenResult(accepted[:total], warnings)
