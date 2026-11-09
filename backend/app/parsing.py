"""Bulk question parsing/import helpers.

Separator rule: a line that consists solely of ``--`` (surrounding whitespace allowed) starts a new
question. A hyphen anywhere else (``-``, ``--`` inside a sentence, ``---`` rules, bullet dashes) never splits.
"""
from __future__ import annotations

import json
import re
from typing import Any

from .schemas import MAX_QUESTION_CHARS, ImportItem, ImportPreviewOut, QuestionIn

SEPARATOR = re.compile(r"^[ \t]*--[ \t]*$")
_INLINE_SEP = re.compile(r"\S[ \t]+--[ \t]+\S")
MAX_IMPORT_QUESTIONS = 500


def normalize_for_dedupe(text: str) -> str:
    t = re.sub(r"\s+", " ", text.casefold()).strip()
    return t.rstrip(" ?.!:;,")


def split_questions(raw: str) -> list[str]:
    """Split on standalone ``--`` lines. Keeps inner newlines/punctuation, trims outer whitespace."""
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    sections: list[list[str]] = [[]]
    for line in lines:
        if SEPARATOR.match(line):
            sections.append([])
        else:
            sections[-1].append(line)
    out = []
    for sec in sections:
        text = "\n".join(sec).strip()
        if text:
            out.append(text)
    return out


def _mark_duplicates(items: list[ImportItem], existing_texts: list[str]) -> int:
    existing = {normalize_for_dedupe(t) for t in existing_texts}
    seen: set[str] = set()
    dups = 0
    for it in items:
        key = normalize_for_dedupe(it.text)
        if key in existing:
            it.duplicate, dups = "existing", dups + 1
        elif key in seen:
            it.duplicate, dups = "batch", dups + 1
        seen.add(key)
    return dups


def preview_text(raw: str, existing_texts: list[str]) -> ImportPreviewOut:
    errors: list[str] = []
    warnings: list[str] = []
    if not raw or not raw.strip():
        return ImportPreviewOut(items=[], count=0, duplicates=0, errors=["Nothing to import: the text is empty."], warnings=[])
    parts = split_questions(raw)
    if len(parts) == 1 and _INLINE_SEP.search(parts[0]):
        warnings.append(
            "Found ' -- ' inside a line. Separators must be a line containing only '--'; "
            "the text was kept as ONE question."
        )
    if len(parts) > MAX_IMPORT_QUESTIONS:
        errors.append(f"Too many questions ({len(parts)}); the limit per import is {MAX_IMPORT_QUESTIONS}.")
        parts = parts[:MAX_IMPORT_QUESTIONS]
    items = []
    for p in parts:
        item = ImportItem(text=p)
        if len(p) > MAX_QUESTION_CHARS:
            item.error = f"Question is {len(p)} characters; the limit is {MAX_QUESTION_CHARS}."
            errors.append(item.error)
        items.append(item)
    dups = _mark_duplicates(items, existing_texts)
    if not items:
        errors.append("No questions detected. Put each question on its own and separate them with a line containing only '--'.")
    return ImportPreviewOut(items=items, count=len(items), duplicates=dups, errors=errors, warnings=warnings)


def preview_json(raw: str, existing_texts: list[str]) -> ImportPreviewOut:
    if not raw or not raw.strip():
        return ImportPreviewOut(items=[], count=0, duplicates=0, errors=["Nothing to import: the file is empty."], warnings=[])
    try:
        data: Any = json.loads(raw)
    except json.JSONDecodeError as e:
        return ImportPreviewOut(
            items=[], count=0, duplicates=0, warnings=[],
            errors=[f"Invalid JSON: {e.msg} (line {e.lineno}, column {e.colno})."],
        )
    set_name = None
    if isinstance(data, dict):
        set_name = data.get("name") if isinstance(data.get("name"), str) else None
        data = data.get("questions")
    if not isinstance(data, list):
        return ImportPreviewOut(
            items=[], count=0, duplicates=0, warnings=[],
            errors=['Expected {"questions": [...]} or a JSON array of questions.'],
        )
    errors: list[str] = []
    items: list[ImportItem] = []
    for i, entry in enumerate(data[:MAX_IMPORT_QUESTIONS], start=1):
        if isinstance(entry, str):
            entry = {"text": entry}
        if not isinstance(entry, dict):
            errors.append(f"Entry {i}: expected an object or a string.")
            continue
        text = entry.get("text", entry.get("question"))
        try:
            q = QuestionIn(text=text, rubric=entry.get("rubric", entry.get("expected_answer")),
                           topic=entry.get("topic"), difficulty=entry.get("difficulty"))
        except Exception as e:  # pydantic ValidationError -> readable message
            first = getattr(e, "errors", lambda: [{"msg": str(e)}])()[0]
            field = ".".join(str(x) for x in first.get("loc", ())) or "entry"
            errors.append(f"Entry {i}: invalid {field} ({first.get('msg')}).")
            continue
        items.append(ImportItem(text=q.text, rubric=q.rubric, topic=q.topic, difficulty=q.difficulty))
    if len(data) > MAX_IMPORT_QUESTIONS:
        errors.append(f"Too many questions ({len(data)}); the limit per import is {MAX_IMPORT_QUESTIONS}.")
    dups = _mark_duplicates(items, existing_texts)
    if not items and not errors:
        errors.append("The file contains no questions.")
    return ImportPreviewOut(items=items, count=len(items), duplicates=dups, errors=errors, warnings=[], set_name=set_name)
