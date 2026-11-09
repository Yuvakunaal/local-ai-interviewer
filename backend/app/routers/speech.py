from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Request, Response, UploadFile

from ..errors import AppError
from ..schemas import SynthesizeIn
from ..services.stt import TranscribeError
from ..services.tts import SpeechError

router = APIRouter(prefix="/api/speech", tags=["speech"])

_STATUS = {"ollama_unavailable": 503, "model_missing": 503, "bad_voice": 400, "empty_audio": 502, "timeout": 504, "failed": 502}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@router.post("/synthesize")
def synthesize(body: SynthesizeIn, request: Request):
    c = request.app.state.c
    try:
        wav = c.speech.synthesize(body.text, body.voice)
    except SpeechError as e:
        raise AppError(_STATUS.get(e.code, 502), e.code, e.message) from e
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.get("/stt")
def stt_status(request: Request):
    return request.app.state.c.stt.status()


@router.post("/transcribe")
async def transcribe(request: Request, audio: UploadFile = File(...)):
    c = request.app.state.c
    data = await audio.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise AppError(400, "empty_audio", "The recording was empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError(413, "too_large", "The recording is too large (25 MB max).")
    c.settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(audio.filename or "rec.webm").suffix[:8] or ".webm"
    with tempfile.NamedTemporaryFile(dir=c.settings.uploads_dir, suffix=suffix, delete=False) as f:
        f.write(data)
        path = f.name
    try:
        from starlette.concurrency import run_in_threadpool

        text = await run_in_threadpool(c.stt.transcribe, path)
    except TranscribeError as e:
        status = 503 if e.code in {"stt_unavailable", "stt_model_missing"} else (422 if e.code == "empty_audio" else 500)
        raise AppError(status, e.code, e.message) from e
    finally:
        Path(path).unlink(missing_ok=True)  # recordings are never kept
    return {"text": text}
