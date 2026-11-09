from __future__ import annotations


class AppError(Exception):
    """Error with a stable machine-readable code, surfaced to the UI as {error: {code, message}}."""

    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def not_found(what: str) -> AppError:
    return AppError(404, "not_found", f"{what} not found.")


def conflict(code: str, message: str, **extra) -> AppError:
    return AppError(409, code, message, **extra)


def bad_request(code: str, message: str) -> AppError:
    return AppError(400, code, message)
