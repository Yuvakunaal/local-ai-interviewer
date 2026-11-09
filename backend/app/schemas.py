"""Typed request/response models and the validated LLM evaluation contract."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

Difficulty = Literal["easy", "medium", "hard"]
InterviewType = Literal["technical", "hr", "scenario", "mixed"]
Strictness = Literal["lenient", "balanced", "strict"]

MAX_QUESTION_CHARS = 4000
MAX_RUBRIC_CHARS = 4000
MAX_ANSWER_CHARS = 8000


def _clean(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ---------------------------------------------------------------- questions
class QuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    rubric: Optional[str] = Field(default=None, max_length=MAX_RUBRIC_CHARS)
    topic: Optional[str] = Field(default=None, max_length=80)
    difficulty: Optional[Difficulty] = None

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip()

    @field_validator("rubric", "topic", mode="before")
    @classmethod
    def _opt(cls, v: Any) -> Optional[str]:
        return _clean(v)

    @field_validator("difficulty", mode="before")
    @classmethod
    def _diff(cls, v: Any) -> Optional[str]:
        v = _clean(v)
        return v.lower() if v else None


class QuestionOut(BaseModel):
    id: int
    set_id: int
    position: int
    text: str
    rubric: Optional[str] = None
    topic: Optional[str] = None
    difficulty: Optional[str] = None
    created_at: str
    updated_at: str


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip()


class SetOut(BaseModel):
    id: int
    name: str
    question_count: int
    created_at: str
    updated_at: str


class ReorderIn(BaseModel):
    ordered_ids: list[int]


class ImportPreviewIn(BaseModel):
    format: Literal["text", "json"] = "text"
    content: str


class ImportItem(BaseModel):
    text: str
    rubric: Optional[str] = None
    topic: Optional[str] = None
    difficulty: Optional[str] = None
    duplicate: Optional[Literal["existing", "batch"]] = None
    error: Optional[str] = None


class ImportPreviewOut(BaseModel):
    items: list[ImportItem]
    count: int
    duplicates: int
    errors: list[str]
    warnings: list[str]
    set_name: Optional[str] = None


class ImportCommitIn(BaseModel):
    mode: Literal["append", "replace"]
    questions: list[QuestionIn]
    confirm_replace: bool = False


class ImportCommitOut(BaseModel):
    added: int
    skipped_duplicates: int
    removed: int
    backup_file: Optional[str] = None


# ---------------------------------------------------------------- interview config
class InterviewConfig(BaseModel):
    title: str = Field(default="Practice interview", min_length=1, max_length=120)
    interview_type: InterviewType = "technical"
    question_ids: Optional[list[int]] = None  # None -> every question in the set
    order: Literal["supplied", "shuffled"] = "supplied"
    max_followups: int = Field(default=1, ge=0, le=3)
    voice: str = "default"
    speech_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    strictness: Strictness = "balanced"
    feedback_mode: Literal["immediate", "after_followups", "at_end"] = "immediate"   # at_end (what the app sends): no scores or feedback until the interview is over
    question_audio: Literal["auto", "manual"] = "auto"
    mic_enabled: bool = False
    include_bank: bool = True          # False: only the reviewed resume questions are asked
    mix: Literal["bank_first", "resume_first", "interleave", "shuffled"] = "bank_first"   # how bank and resume questions are ordered

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip() or "Practice interview"


MAX_INTERVIEW_QUESTIONS = 60


class ClaimIn(BaseModel):
    """What a resume question is about: a snapshot kept with the interview, so reports survive the resume being deleted."""

    section: str = Field(default="", max_length=60)
    label: str = Field(default="", max_length=200)
    excerpt: str = Field(default="", max_length=400)

    @field_validator("section", "label", "excerpt", mode="before")
    @classmethod
    def _s(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip()


class ResumeQuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    rubric: Optional[str] = Field(default=None, max_length=1500)
    topic: Optional[str] = Field(default=None, max_length=80)
    difficulty: Optional[Difficulty] = None
    kind: Optional[str] = Field(default=None, max_length=40)
    resume_id: Optional[int] = None
    resume_name: Optional[str] = Field(default=None, max_length=120)
    claim: Optional[ClaimIn] = None

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip()

    @field_validator("rubric", "topic", "kind", "resume_name", mode="before")
    @classmethod
    def _opt(cls, v: Any) -> Optional[str]:
        return _clean(v)

    @field_validator("difficulty", mode="before")
    @classmethod
    def _diff(cls, v: Any) -> Optional[str]:
        v = _clean(v)
        return v.lower() if v else None


class CreateInterviewIn(BaseModel):
    set_id: Optional[int] = None                       # None: no question-bank questions (a resume-only interview)
    config: InterviewConfig
    resume_questions: list[ResumeQuestionIn] = Field(default_factory=list, max_length=MAX_INTERVIEW_QUESTIONS)


class AnswerIn(BaseModel):
    turn_id: int
    text: str
    source: Literal["typed", "voice"] = "typed"

    @field_validator("text", mode="before")
    @classmethod
    def _t(cls, v: Any) -> str:
        return (str(v) if v is not None else "").strip()


class TurnRefIn(BaseModel):
    turn_id: int


class SynthesizeIn(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    voice: str = "default"


class RubricSettings(BaseModel):
    """Weights per scoring dimension. Re-normalised at scoring time, so they need not sum to 1."""

    correctness: float = Field(default=0.30, ge=0, le=1)
    completeness: float = Field(default=0.20, ge=0, le=1)
    depth: float = Field(default=0.15, ge=0, le=1)
    practical_application: float = Field(default=0.15, ge=0, le=1)
    clarity: float = Field(default=0.10, ge=0, le=1)
    production_awareness: float = Field(default=0.10, ge=0, le=1)
    extra_guidance: str = Field(default="", max_length=1500)


# ---------------------------------------------------------------- LLM evaluation contract
def _str_list(v: Any, limit: int = 6) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        v = [v]
    out = []
    for item in v:
        text = str(item).strip()
        if text and text.lower() not in {"none", "n/a", "na", "-"}:
            out.append(text[:500])
    return out[:limit]


def _score(v: Any) -> int:
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ValueError("score must be numeric")
    return int(round(min(10.0, max(0.0, n))))


class DimensionScores(BaseModel):
    correctness: int
    completeness: int
    depth: int
    practical_application: int
    clarity: int
    production_awareness: int = 0

    @field_validator("*", mode="before")
    @classmethod
    def _clamp(cls, v: Any) -> int:
        return _score(v)


class LLMEvaluation(BaseModel):
    """Exactly what the model must return. Validated before it is trusted."""

    question_level: Literal["basic", "standard", "advanced"] = "standard"
    graded_by: Optional[dict[str, Any]] = None      # which engine and model produced this (set by the app, never trusted from the model)
    correct_points: list[str] = []
    missing_concepts: list[str] = []
    misconceptions: list[str] = []
    dimension_scores: DimensionScores
    production_relevant: bool = False
    verdict_summary: str = ""
    suggested_improvements: list[str] = []
    ideal_answer: str = ""
    confidence: Literal["high", "medium", "low"] = "medium"
    uncertainty_note: str = ""
    needs_followup: bool = False
    followup_question: str = ""
    followup_reason: str = ""

    @field_validator("question_level", mode="before")
    @classmethod
    def _level(cls, v: Any) -> str:
        v = str(v or "").strip().lower()
        return v if v in {"basic", "standard", "advanced"} else "standard"

    @field_validator("correct_points", "missing_concepts", "misconceptions", "suggested_improvements", mode="before")
    @classmethod
    def _lists(cls, v: Any) -> list[str]:
        return _str_list(v)

    @field_validator("ideal_answer", "uncertainty_note", "followup_question", "followup_reason", "verdict_summary", mode="before")
    @classmethod
    def _strs(cls, v: Any) -> str:
        return (str(v).strip() if v is not None else "")[:1500]

    @field_validator("confidence", mode="before")
    @classmethod
    def _conf(cls, v: Any) -> str:
        v = str(v or "medium").strip().lower()
        return v if v in {"high", "medium", "low"} else "medium"

    @field_validator("needs_followup", "production_relevant", mode="before")
    @classmethod
    def _bool(cls, v: Any) -> bool:
        if isinstance(v, str):
            return v.strip().lower() in {"true", "yes", "1"}
        return bool(v)


class Evaluation(LLMEvaluation):
    """LLMEvaluation + values computed by application code (never trusted from the model)."""

    score: float
    verdict: str
    interpreted_answer: Optional[str] = None   # voice answers: the transcript after speech-recognition repair (what was graded)
    followup_asked: bool = False
    followup_suppressed_reason: Optional[str] = None


# ---------------------------------------------------------------- resumes
def _s(v: Any) -> str:
    return (str(v) if v is not None else "").strip()


class _Strict(BaseModel):
    """Every text field: trimmed, None -> "". Lengths are hard limits (an over-long edit is rejected, not cut)."""

    @field_validator("*", mode="before")
    @classmethod
    def _strip(cls, v: Any, info) -> Any:
        field = cls.model_fields.get(info.field_name)
        if field is not None and field.annotation is str:
            return _s(v)
        if isinstance(v, list):          # lists of text: trimmed, blank items dropped
            out = [(_s(x) if isinstance(x, (str, type(None))) else x) for x in v]
            return [x for x in out if x != ""]
        return v


class ResumeContact(_Strict):
    name: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=80)
    location: str = Field(default="", max_length=200)
    links: list[str] = Field(default_factory=list, max_length=12)


class SkillGroup(_Strict):
    group: str = Field(default="", max_length=60)
    items: list[str] = Field(default_factory=list, max_length=80)


class ExperienceEntry(_Strict):
    company: str = Field(default="", max_length=160)
    title: str = Field(default="", max_length=160)
    location: str = Field(default="", max_length=120)
    start: str = Field(default="", max_length=40)
    end: str = Field(default="", max_length=40)
    is_current: bool = False
    bullets: list[str] = Field(default_factory=list, max_length=25)


class ProjectEntry(_Strict):
    name: str = Field(default="", max_length=160)
    role: str = Field(default="", max_length=120)
    tech: list[str] = Field(default_factory=list, max_length=40)
    link: str = Field(default="", max_length=300)
    bullets: list[str] = Field(default_factory=list, max_length=25)


class EducationEntry(_Strict):
    school: str = Field(default="", max_length=160)
    degree: str = Field(default="", max_length=160)
    field: str = Field(default="", max_length=160)
    start: str = Field(default="", max_length=40)
    end: str = Field(default="", max_length=40)
    details: str = Field(default="", max_length=800)


class ResumeProfile(_Strict):
    """The organised, editable content of one resume. The same shape is produced by the AI and saved by the editor."""

    contact: ResumeContact = Field(default_factory=ResumeContact)
    summary: str = Field(default="", max_length=3000)
    skills: list[SkillGroup] = Field(default_factory=list, max_length=20)
    experience: list[ExperienceEntry] = Field(default_factory=list, max_length=40)
    projects: list[ProjectEntry] = Field(default_factory=list, max_length=40)
    education: list[EducationEntry] = Field(default_factory=list, max_length=20)
    certifications: list[str] = Field(default_factory=list, max_length=50)
    achievements: list[str] = Field(default_factory=list, max_length=50)
    other: list[str] = Field(default_factory=list, max_length=50)
    parse_warnings: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("certifications", "achievements", "other", "parse_warnings")
    @classmethod
    def _items(cls, v: list[str]) -> list[str]:
        for x in v:
            if len(x) > 800:
                raise ValueError("an item is longer than 800 characters")
        return v

    @field_validator("contact", "skills", "experience", "projects", "education")
    @classmethod
    def _nested_items(cls, v: Any) -> Any:
        def check(items: list[str], limit: int) -> None:
            for x in items:
                if len(x) > limit:
                    raise ValueError(f"an item is longer than {limit} characters")
        for entry in (v if isinstance(v, list) else [v]):
            if isinstance(entry, ResumeContact):
                check(entry.links, 300)
            elif isinstance(entry, SkillGroup):
                check(entry.items, 80)
            elif isinstance(entry, ProjectEntry):
                check(entry.tech, 60)
                check(entry.bullets, 800)
            elif isinstance(entry, ExperienceEntry):
                check(entry.bullets, 800)
        return v


class ResumePatchIn(BaseModel):
    revision: int                                       # the revision the editor started from; a different one means another tab saved first
    name: Optional[str] = Field(default=None, max_length=60)
    profile: Optional[ResumeProfile] = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> Optional[str]:
        return None if v is None else _s(v)


class ResumeConsentIn(BaseModel):
    accept: bool


FocusArea = Literal["experience", "projects", "skills", "achievements", "education", "behavioural", "gaps"]


class GenerateQuestionsIn(BaseModel):
    resume_ids: list[int] = Field(min_length=1, max_length=10)
    count: int = Field(default=8, ge=3, le=20)
    focus: list[FocusArea] = Field(default_factory=lambda: ["experience", "projects", "skills", "achievements"], min_length=1, max_length=7)
    depth: Literal["overview", "standard", "deep"] = "standard"
    difficulty: Literal["mixed", "easy", "medium", "hard"] = "mixed"
    style: Literal["recruiter", "manager", "skeptic"] = "manager"
    exclude_texts: list[str] = Field(default_factory=list, max_length=80)

    @field_validator("exclude_texts")
    @classmethod
    def _ex(cls, v: list[str]) -> list[str]:
        return [str(x)[:1000] for x in v]


class GenerateOneIn(BaseModel):
    resume_id: int
    claim: ClaimIn
    kind: Optional[str] = Field(default=None, max_length=40)
    difficulty: Literal["mixed", "easy", "medium", "hard"] = "mixed"
    style: Literal["recruiter", "manager", "skeptic"] = "manager"
    existing_texts: list[str] = Field(default_factory=list, max_length=80)

    @field_validator("existing_texts")
    @classmethod
    def _ex(cls, v: list[str]) -> list[str]:
        return [str(x)[:1000] for x in v]
