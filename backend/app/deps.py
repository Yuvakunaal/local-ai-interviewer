"""Application container: builds the services once and hands them to the routers."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from .config import Settings
from .db import Database
from .services.ai_config import AIConfigStore
from .services.cloud import CloudClient
from .services.evaluator import Evaluator
from .services.gateway import LLMGateway
from .services.model_pull import ModelPuller
from .services.interviews import InterviewService
from .services.ollama import OllamaClient
from .services.questions import QuestionService
from .services.resumes import ResumeService
from .services.stt import TranscriptionService
from .services.tts import SpeechService
from .services.usage import UsageRecorder


@dataclass
class Container:
    settings: Settings
    db: Database
    ollama: OllamaClient
    questions: QuestionService
    speech: SpeechService
    stt: TranscriptionService
    evaluator: Evaluator
    interviews: InterviewService
    usage: UsageRecorder
    ai: AIConfigStore
    cloud: CloudClient
    gateway: LLMGateway
    puller: ModelPuller
    resumes: ResumeService


def _private(settings: Settings) -> None:
    """The data folder holds answers and (if the user adds one) a cloud API key: make it readable by this user only (best effort; no-op on Windows)."""
    try:
        os.chmod(settings.data_dir, 0o700)
        for name in (settings.db_path.name, settings.db_path.name + "-wal", settings.db_path.name + "-shm"):
            if (settings.data_dir / name).exists():
                os.chmod(settings.data_dir / name, 0o600)
    except OSError:
        pass


def build_container(settings: Settings, *, ollama: Optional[OllamaClient] = None, db: Optional[Database] = None,
                    executor=None, cloud: Optional[CloudClient] = None) -> Container:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = db or Database(settings.db_path)
    _private(settings)
    ollama = ollama or OllamaClient(settings)
    ai = AIConfigStore(db)
    usage = UsageRecorder(db, prices=lambda: ai.get().prices)
    cloud = cloud or CloudClient(settings, key=ai.api_key)
    ollama.on_usage = usage.record          # tokens, timings and (cloud) cost of every model reply, kept locally (Model usage page)
    cloud.on_usage = usage.record
    gateway = LLMGateway(ollama, cloud, ai, usage)       # chooses local or cloud per request; local unless the user opted in
    questions = QuestionService(db, settings)
    evaluator = Evaluator(gateway)
    interviews = InterviewService(db, questions, evaluator, executor=executor)
    # resume reading and question writing run on their own worker; each model request still takes the one global LLM lock,
    # so an interview evaluation waits at most for one small resume request, never for a whole resume
    resumes = ResumeService(db, settings, evaluator, questions, executor=executor, release=interviews._release_model_if_idle, is_cloud=gateway.is_cloud)
    interviews.busy_checks.append(resumes.is_working)       # the model is not unloaded while a resume is being organised
    return Container(
        settings=settings, db=db, ollama=ollama, questions=questions, speech=SpeechService(settings, ollama),
        stt=TranscriptionService(settings), evaluator=evaluator,
        interviews=interviews, usage=usage, ai=ai, cloud=cloud, gateway=gateway,
        puller=ModelPuller(ollama, settings), resumes=resumes,
    )
