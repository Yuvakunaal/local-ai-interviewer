"""Turning cleaned resume text into the structured, editable profile.

The model's context is small (LLM_NUM_CTX 6144 on an 8 GB computer), so the text is split into parts of at most ~2,800 characters at section
and paragraph boundaries; each part is organised separately and the parts are MERGED here, in code, deterministically. The model only ever
reports what is in the part it is given; this module decides how the parts fit together and clamps everything to safe sizes.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from ..schemas import ResumeProfile

CHUNK_CHARS = 2800

HEADINGS = {
    "summary": ["summary", "professional summary", "profile", "professional profile", "objective", "career objective", "about", "about me", "overview"],
    "experience": ["experience", "work experience", "professional experience", "employment", "employment history", "work history", "career history",
                   "relevant experience", "career", "professional background", "internships", "internship"],
    "projects": ["projects", "personal projects", "key projects", "selected projects", "side projects", "academic projects", "open source"],
    "education": ["education", "academic background", "academics", "qualifications", "education and training"],
    "skills": ["skills", "technical skills", "core competencies", "competencies", "technologies", "tech stack", "tools", "key skills", "expertise", "skills and tools"],
    "certifications": ["certifications", "certificates", "licenses", "licences", "licenses and certifications", "certifications and licenses", "courses"],
    "achievements": ["achievements", "awards", "honors", "honours", "accomplishments", "awards and honors", "publications", "awards and achievements"],
    "other": ["languages", "volunteering", "volunteer", "volunteer experience", "interests", "hobbies", "activities", "references", "additional information"],
}
_HEADING_INDEX = {h: key for key, names in HEADINGS.items() for h in names}


def _heading_key(line: str) -> Optional[str]:
    """A short line that names a resume section ("EXPERIENCE", "Work history:", "Skills & Tools")."""
    text = line.strip().strip(":").strip()
    if not text or len(text) > 40 or text.startswith("•"):
        return None
    norm = re.sub(r"[^a-z ]+", " ", text.lower().replace("&", " and ")).strip()
    norm = re.sub(r"\s+", " ", norm)
    return _HEADING_INDEX.get(norm)


def split_sections(text: str) -> list[tuple[str, str]]:
    """[(heading line or "", body)] in document order. Text before the first heading has an empty heading."""
    out: list[tuple[str, list[str]]] = [("", [])]
    for line in text.split("\n"):
        if _heading_key(line):
            out.append((line.strip(), []))
        else:
            out[-1][1].append(line)
    return [(h, "\n".join(body).strip()) for h, body in out if h or "\n".join(body).strip()]


def _split_big(body: str, limit: int) -> list[str]:
    """Split one long section on blank lines, then lines, then (last resort) at the limit."""
    parts: list[str] = []
    buf = ""
    units = [u for u in re.split(r"\n\s*\n", body) if u.strip()]
    flat: list[str] = []
    for u in units:
        if len(u) <= limit:
            flat.append(u)
            continue
        line_buf = ""
        for line in u.split("\n"):
            while len(line) > limit:                           # one enormous line (rare: a PDF without line breaks)
                if line_buf:
                    flat.append(line_buf)
                    line_buf = ""
                cut = line.rfind(" ", 0, limit)
                cut = cut if cut > limit // 2 else limit
                flat.append(line[:cut])
                line = line[cut:].lstrip()
            if len(line_buf) + len(line) + 1 > limit and line_buf:
                flat.append(line_buf)
                line_buf = ""
            line_buf = f"{line_buf}\n{line}" if line_buf else line
        if line_buf:
            flat.append(line_buf)
    for u in flat:
        if len(buf) + len(u) + 2 > limit and buf:
            parts.append(buf)
            buf = ""
        buf = f"{buf}\n\n{u}" if buf else u
    if buf:
        parts.append(buf)
    return parts


def chunk_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Parts of at most `limit` characters, cut at section boundaries where possible. A section split over several parts repeats its heading
    as "<HEADING> (continued)" so the model knows what it is reading. Page markers are removed (they only confuse the model)."""
    from .resume_extract import strip_page_markers
    text = strip_page_markers(text)
    if not text.strip():
        return []
    chunks: list[str] = []
    buf = ""
    for heading, body in split_sections(text):
        block = f"{heading}\n{body}".strip() if heading else body
        if len(block) <= limit:
            if len(buf) + len(block) + 2 > limit and buf:
                chunks.append(buf)
                buf = ""
            buf = f"{buf}\n\n{block}" if buf else block
            continue
        if buf:
            chunks.append(buf)
            buf = ""
        head_room = len(heading) + 14
        for k, piece in enumerate(_split_big(body, limit - head_room)):
            label = heading if k == 0 else (f"{heading} (continued)" if heading else "")
            chunks.append(f"{label}\n{piece}".strip())
    if buf:
        chunks.append(buf)
    return chunks


# ---------------------------------------------------------------- coercion of model output (clamp instead of reject)
LIMITS = {"str": 160, "long": 800, "summary": 3000, "skills": 20, "skill_items": 80, "experience": 40, "projects": 40, "education": 20,
          "list": 50, "bullets": 25, "tech": 40, "links": 12}


def _t(v: Any, n: int) -> str:
    text = re.sub(r"[ \t]+", " ", str(v if v is not None else "")).strip()
    return "" if text.lower() in {"none", "n/a", "null", "-"} else text[:n]


def _tl(v: Any, n_items: int, n_chars: int) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        v = [x for x in re.split(r"\n+", v)]
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        s = _t(x, n_chars).lstrip("•-* ").strip()
        if s:
            out.append(s)
    return out[:n_items]


def _d(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _dl(v: Any, n: int) -> list[dict]:
    return [x for x in v if isinstance(x, dict)][:n] if isinstance(v, list) else []


def coerce_profile(raw: Any) -> ResumeProfile:
    """Model output -> a valid ResumeProfile: wrong types become empty, long text is cut, lists are capped."""
    r = _d(raw)
    c = _d(r.get("contact"))
    current = lambda e: bool(e.get("is_current")) if not isinstance(e.get("is_current"), str) else e["is_current"].strip().lower() in {"true", "yes", "1"}  # noqa: E731
    return ResumeProfile.model_validate({
        "contact": {"name": _t(c.get("name"), 200), "email": _t(c.get("email"), 200), "phone": _t(c.get("phone"), 80), "location": _t(c.get("location"), 200),
                    "links": _tl(c.get("links"), LIMITS["links"], 300)},
        "summary": _t(r.get("summary"), LIMITS["summary"]),
        "skills": [{"group": _t(g.get("group"), 60) or "Other", "items": _tl(g.get("items"), LIMITS["skill_items"], 80)} for g in _dl(r.get("skills"), LIMITS["skills"])],
        "experience": [{"company": _t(e.get("company"), 160), "title": _t(e.get("title"), 160), "location": _t(e.get("location"), 120), "start": _t(e.get("start"), 40),
                        "end": _t(e.get("end"), 40), "is_current": current(e), "bullets": _tl(e.get("bullets"), LIMITS["bullets"], 800)}
                       for e in _dl(r.get("experience"), LIMITS["experience"])],
        "projects": [{"name": _t(e.get("name"), 160), "role": _t(e.get("role"), 120), "tech": _tl(e.get("tech"), LIMITS["tech"], 60), "link": _t(e.get("link"), 300),
                      "bullets": _tl(e.get("bullets"), LIMITS["bullets"], 800)} for e in _dl(r.get("projects"), LIMITS["projects"])],
        "education": [{"school": _t(e.get("school"), 160), "degree": _t(e.get("degree"), 160), "field": _t(e.get("field"), 160), "start": _t(e.get("start"), 40),
                       "end": _t(e.get("end"), 40), "details": _t(e.get("details"), 800)} for e in _dl(r.get("education"), LIMITS["education"])],
        "certifications": _tl(r.get("certifications"), LIMITS["list"], 800),
        "achievements": _tl(r.get("achievements"), LIMITS["list"], 800),
        "other": _tl(r.get("other"), LIMITS["list"], 800),
    })


# ---------------------------------------------------------------- merging the parts
def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _tokens(text: str) -> set[str]:
    return {t for t in norm(text).split() if len(t) > 2}


def near_same(a: str, b: str, threshold: float = 0.85) -> bool:
    if norm(a) == norm(b):
        return True
    ta, tb = _tokens(a), _tokens(b)
    if min(len(ta), len(tb)) < 4:                    # short items ("Built A" / "Built B") must match exactly
        return False
    return len(ta & tb) / len(ta | tb) >= threshold


def dedupe_texts(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    for x in items:
        if x and not any(near_same(x, y) for y in out):
            out.append(x)
    return out


def _fill(dst: dict, src: dict, keys: Iterable[str]) -> None:
    for k in keys:
        if not dst.get(k) and src.get(k):
            dst[k] = src[k]


def _same_role(a: dict, b: dict) -> bool:
    """Same job: same company and title (a part boundary can cut a role in two, the second half often without dates)."""
    if not norm(a.get("company", "")) or norm(a.get("company", "")) != norm(b.get("company", "")):
        return False
    ta, tb = norm(a.get("title", "")), norm(b.get("title", ""))
    if ta and tb and ta != tb:
        return False
    sa, sb = norm(a.get("start", "")), norm(b.get("start", ""))
    return not (sa and sb and sa != sb)


def _orphan(e: dict, name_key: str) -> bool:
    """An entry with bullets but no identity: the tail of an entry cut by a part boundary."""
    return not norm(e.get(name_key, "")) and not norm(e.get("title", "")) and bool(e.get("bullets"))


def _merge_entries(acc: list[dict], new: list[dict], same, name_key: str, fill_keys: tuple[str, ...]) -> None:
    for i, e in enumerate(new):
        e = dict(e)
        if i == 0 and acc and _orphan(e, name_key):           # continuation of the previous part's last entry
            acc[-1]["bullets"] = dedupe_texts(acc[-1].get("bullets", []) + e.get("bullets", []))
            continue
        match = next((a for a in acc if same(a, e)), None)
        if match:
            match["bullets"] = dedupe_texts(match.get("bullets", []) + e.get("bullets", []))
            if "tech" in e:
                match["tech"] = dedupe_texts(match.get("tech", []) + e.get("tech", []))
            _fill(match, e, fill_keys)
            if e.get("is_current"):
                match["is_current"] = True
        else:
            acc.append(e)


def merge_profiles(parts: list[ResumeProfile]) -> ResumeProfile:
    """Combine the per-part results: lists concatenated in order, duplicates removed, a role split across parts stitched back together,
    skill groups merged case-insensitively, and the first non-empty contact detail wins."""
    contact: dict[str, Any] = {"name": "", "email": "", "phone": "", "location": "", "links": []}
    summary: list[str] = []
    skills: dict[str, dict] = {}
    experience: list[dict] = []
    projects: list[dict] = []
    education: list[dict] = []
    certs: list[str] = []
    achievements: list[str] = []
    other: list[str] = []
    for p in parts:
        d = p.model_dump()
        _fill(contact, d["contact"], ("name", "email", "phone", "location"))
        contact["links"] = dedupe_texts(contact["links"] + d["contact"]["links"])
        if d["summary"]:
            summary.append(d["summary"])
        for g in d["skills"]:
            key = norm(g["group"]) or "other"
            grp = skills.setdefault(key, {"group": g["group"] or "Other", "items": []})
            for item in g["items"]:
                if not any(norm(item) == norm(x) for x in grp["items"]):
                    grp["items"].append(item)
        _merge_entries(experience, d["experience"], _same_role, "company", ("title", "location", "start", "end"))
        _merge_entries(projects, d["projects"], lambda a, b: bool(norm(a["name"])) and norm(a["name"]) == norm(b["name"]), "name", ("role", "link"))
        for e in d["education"]:
            m = next((x for x in education if norm(x["school"]) and norm(x["school"]) == norm(e["school"]) and (not norm(x["degree"]) or not norm(e["degree"]) or norm(x["degree"]) == norm(e["degree"]))), None)
            if m:
                _fill(m, e, ("degree", "field", "start", "end", "details"))
            else:
                education.append(dict(e))
        certs += d["certifications"]
        achievements += d["achievements"]
        other += d["other"]
    # a skill that is only repeated across groups stays where it first appeared
    return ResumeProfile.model_validate({
        "contact": contact, "summary": "\n\n".join(dedupe_texts(summary))[:LIMITS["summary"]],
        "skills": [g for g in skills.values() if g["items"]][:LIMITS["skills"]],
        "experience": [e for e in experience if norm(e.get("company", "")) or norm(e.get("title", "")) or e.get("bullets")][:LIMITS["experience"]],
        "projects": [e for e in projects if norm(e.get("name", "")) or e.get("bullets")][:LIMITS["projects"]],
        "education": [e for e in education if norm(e.get("school", "")) or norm(e.get("degree", ""))][:LIMITS["education"]],
        "certifications": dedupe_texts(certs)[:LIMITS["list"]], "achievements": dedupe_texts(achievements)[:LIMITS["list"]],
        "other": dedupe_texts(other)[:LIMITS["list"]],
    })


def is_empty(p: ResumeProfile) -> bool:
    return not (p.contact.name or p.summary or p.skills or p.experience or p.projects or p.education or p.certifications or p.achievements or p.other)


def skill_preview(p: Optional[ResumeProfile], n: int = 6) -> list[str]:
    if not p:
        return []
    out: list[str] = []
    for g in p.skills:
        for item in g.items:
            if item not in out:
                out.append(item)
            if len(out) >= n:
                return out
    return out
