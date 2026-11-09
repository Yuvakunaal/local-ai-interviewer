"""FastAPI application factory: JSON API under /api, built React app served at /."""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings
from .deps import Container, build_container
from .errors import AppError
from .routers import ai, interviews, library, resumes, setup, speech, system

class SelectiveGZip:
    """Compress JSON, pages, scripts and styles for the browser; leave audio uploads/downloads untouched."""

    def __init__(self, app):
        self.plain = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=5)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not scope["path"].startswith("/api/speech"):
            await self.gzip(scope, receive, send)
        else:
            await self.plain(scope, receive, send)


LOCAL_HOST_RE = re.compile(r"^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", re.I)
log = logging.getLogger("interviewer")


def create_app(settings: Optional[Settings] = None, container: Optional[Container] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs only, but keep logs quiet
    app = FastAPI(title="Local AI Interviewer", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.c = container or build_container(settings)

    @app.middleware("http")
    async def local_only_guard(request: Request, call_next):
        """Reject DNS-rebinding and cross-site requests: only loopback Host/Origin values are served."""
        host = request.headers.get("host", "")
        if not LOCAL_HOST_RE.match(host):
            return JSONResponse({"error": {"code": "forbidden_host", "message": "Local access only."}}, status_code=403)
        origin = request.headers.get("origin")
        if origin and request.method not in ("GET", "HEAD", "OPTIONS"):
            if not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", origin, re.I):
                return JSONResponse({"error": {"code": "forbidden_origin", "message": "Cross-site request blocked."}}, status_code=403)
        return await call_next(request)

    @app.exception_handler(AppError)
    async def app_error(_: Request, e: AppError):
        return JSONResponse({"error": {"code": e.code, "message": e.message, **e.extra}}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        field = ".".join(str(x) for x in first.get("loc", ())[1:]) or "request"
        return JSONResponse({"error": {"code": "invalid_request", "message": f"Invalid {field}: {first.get('msg', 'bad value')}"}},
                            status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, e: StarletteHTTPException):
        return JSONResponse({"error": {"code": "http_error", "message": str(e.detail)}}, status_code=e.status_code)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, e: Exception):
        log.exception("unhandled error")
        return JSONResponse({"error": {"code": "internal", "message": "Unexpected server error. See logs/backend.log."}}, status_code=500)

    for r in (system.router, library.router, interviews.router, speech.router, ai.router, setup.router, resumes.router):
        app.include_router(r)
    app.add_middleware(SelectiveGZip)

    dist: Path = settings.frontend_dist
    if dist.is_dir():
        index = dist / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                return JSONResponse({"error": {"code": "not_found", "message": "Unknown API route."}}, status_code=404)
            target = (dist / path).resolve()
            if path and target.is_file() and dist.resolve() in target.parents:
                # build output has content-hashed names: the browser may keep them for good; anything else is re-checked
                hashed = path.startswith("assets/")
                return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable" if hashed else "no-cache"})
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        @app.get("/", include_in_schema=False)
        def no_ui():
            return JSONResponse({"message": "Frontend not built. Run ./start.sh (builds it) or `npm run build` in frontend/."})

    return app


def app_factory() -> FastAPI:  # uvicorn --factory target
    return create_app()
