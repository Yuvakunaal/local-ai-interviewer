"""Reading a resume PDF: the text of each page (pypdfium2), Tesseract OCR for scanned pages, and a careful clean-up.

Nothing here talks to the network. pypdfium2 only extracts text and renders pages (it never runs scripts inside a PDF). OCR runs the
`tesseract` program as a subprocess on a temporary PNG under data/tmp/, which is always deleted afterwards. When pypdfium2 or Tesseract is
missing the app keeps working: the caller gets a clear error code and a plain-English message with the install command for this OS.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import unicodedata
import uuid
import zlib
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from ..config import Settings
from .setup_check import os_key

log = logging.getLogger("interviewer.resume_extract")

SCANNED_PAGE_CHARS = 40          # a page with fewer non-space characters than this is treated as a scanned image
MIN_DOCUMENT_CHARS = 200         # less than this after OCR: there is nothing to work with
MAX_TEXT_CHARS = 24_000          # cleaned text is capped (a resume is rarely longer; keeps the model's work small)
OCR_DPI = 300
OCR_MAX_SIDE_PX = 3000           # protects RAM on an 8 GB computer
OCR_TIMEOUT_S = 60
PDF_MAGIC = b"%PDF-"
PASSWORD_ERROR = 4               # PDFium's FPDF_ERR_PASSWORD

INSTALL_COMMANDS = {"macos": "brew install tesseract", "windows": "winget install UB-Mannheim.TesseractOCR", "linux": "sudo apt install tesseract-ocr"}
_LANGS_RE = re.compile(r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$")


class PdfError(Exception):
    """A problem with the uploaded file itself (code + plain-English message)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# ---------------------------------------------------------------- pypdfium2 (optional import, so the app runs without it)
def _pdfium():
    try:
        import pypdfium2 as pdfium  # noqa: PLC0415
    except ImportError as e:  # pragma: no cover - exercised only when the dependency is missing
        raise PdfError("pdf_support_missing", "Reading PDFs needs the pypdfium2 package. Run the start script again (it installs it), "
                                              "or: pip install -r backend/requirements.txt") from e
    return pdfium


def pdf_available() -> bool:
    try:
        _pdfium()
        return True
    except PdfError:
        return False


def open_pdf(data: bytes):
    """Open a PDF from bytes. Raises PdfError for not-a-PDF, password-protected and damaged files."""
    if not data:
        raise PdfError("resume_empty", "The file is empty.")
    if not data.startswith(PDF_MAGIC):
        raise PdfError("not_a_pdf", "This file is not a PDF. Save or export your resume as a PDF and upload that.")
    pdfium = _pdfium()
    try:
        return pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        if getattr(e, "err_code", None) == PASSWORD_ERROR:
            raise PdfError("resume_encrypted", "This PDF is password-protected. Open it, save a copy without a password (Print → Save as PDF works), and upload that.") from e
        raise PdfError("resume_unreadable", "This PDF looks damaged and could not be opened. Export it again from your editor and upload the new file.") from e


def count_pages(data: bytes) -> int:
    doc = open_pdf(data)
    try:
        return len(doc)
    finally:
        doc.close()


# ---------------------------------------------------------------- Tesseract
def tesseract_candidates(system: str, env: Optional[dict[str, str]] = None) -> list[str]:
    """Where Tesseract usually lives when it is not on PATH (installer defaults per OS)."""
    env = env if env is not None else dict(os.environ)
    if system == "windows":
        out = [r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]
        local = env.get("LOCALAPPDATA")
        if local:
            out.append(str(Path(local) / "Programs" / "Tesseract-OCR" / "tesseract.exe"))
        return out
    if system == "macos":
        return ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "/opt/local/bin/tesseract"]
    return ["/usr/bin/tesseract", "/usr/local/bin/tesseract", "/snap/bin/tesseract"]


def find_tesseract(override: str = "", *, system: Optional[str] = None, which: Callable[[str], Optional[str]] = shutil.which,
                   is_file: Callable[[str], bool] = os.path.isfile, env: Optional[dict[str, str]] = None) -> Optional[str]:
    """TESSERACT_CMD -> PATH -> the installer's default folders for this OS. Pure enough to unit-test every OS on any OS."""
    if override:
        return override if is_file(override) else None        # an explicit path that does not exist is reported, not silently replaced
    found = which("tesseract")
    if found:
        return found
    return next((c for c in tesseract_candidates(system or os_key(), env) if is_file(c)), None)


def install_hint(system: Optional[str] = None) -> str:
    return INSTALL_COMMANDS.get(system or os_key(), INSTALL_COMMANDS["linux"])


_status_cache: dict[str, object] = {"at": 0.0, "key": None, "value": None}
_status_lock = threading.Lock()
STATUS_TTL_S = 30.0


def _no_window() -> dict:
    """On Windows, do not flash a console window for each OCR call."""
    if os.name == "nt":  # pragma: no cover - Windows only
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _tesseract_version(path: str) -> Optional[str]:
    try:
        r = subprocess.run([path, "--version"], capture_output=True, timeout=10, **_no_window())
    except (OSError, subprocess.SubprocessError):
        return None
    first = (r.stdout or r.stderr or b"").decode("utf-8", "replace").strip().splitlines()
    return first[0].strip()[:80] if first else None


def ocr_status(settings: Settings, *, fresh: bool = False) -> dict[str, object]:
    """Is OCR usable here? Cached for a few seconds (it may run `tesseract --version`). Never raises."""
    key = (settings.tesseract_cmd, settings.ocr_enabled, settings.ocr_langs)
    with _status_lock:
        if not fresh and _status_cache["key"] == key and time.monotonic() - float(_status_cache["at"]) < STATUS_TTL_S:
            return dict(_status_cache["value"])  # type: ignore[arg-type]
    system = os_key()
    path = find_tesseract(settings.tesseract_cmd)
    version = _tesseract_version(path) if path else None
    langs_ok = bool(_LANGS_RE.match(settings.ocr_langs))
    available = bool(path and version and settings.ocr_enabled and langs_ok)
    if not settings.ocr_enabled:
        reason = "turned off (OCR_ENABLED=0)"
    elif not langs_ok:
        reason = f"OCR_LANGS={settings.ocr_langs!r} is not valid (use codes like eng or eng+deu)"
    elif settings.tesseract_cmd and not path:
        reason = f"TESSERACT_CMD points to a file that does not exist ({settings.tesseract_cmd})"
    elif not path:
        reason = "not installed"
    elif not version:
        reason = "found but it would not run"
    else:
        reason = None
    value = {"available": available, "enabled": settings.ocr_enabled, "path": path, "version": version, "langs": settings.ocr_langs,
             "reason": reason, "os": system, "install": install_hint(system), "install_all": dict(INSTALL_COMMANDS)}
    with _status_lock:
        _status_cache.update(at=time.monotonic(), key=key, value=value)
    return dict(value)


def png_bytes(gray: bytes, width: int, height: int, stride: int) -> bytes:
    """An 8-bit grayscale PNG from a raw bitmap (no imaging library needed)."""
    rows = b"".join(b"\x00" + gray[y * stride: y * stride + width] for y in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


class OcrError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def ocr_png(png: bytes, settings: Settings, tesseract: str) -> str:
    """Run Tesseract on one page image. The temporary file is always removed."""
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    path = settings.tmp_dir / f"ocr-{uuid.uuid4().hex}.png"
    try:
        path.write_bytes(png)
        r = subprocess.run([tesseract, str(path), "stdout", "-l", settings.ocr_langs, "--psm", "3"],
                           capture_output=True, timeout=OCR_TIMEOUT_S, **_no_window())
        if r.returncode != 0:
            err = (r.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise OcrError("ocr_failed", f"Tesseract could not read a page ({(err[-1] if err else 'exit code ' + str(r.returncode))[:200]}).")
        return (r.stdout or b"").decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        raise OcrError("ocr_timeout", f"Reading a scanned page took longer than {OCR_TIMEOUT_S} seconds.") from e
    except OSError as e:
        raise OcrError("ocr_failed", f"Tesseract could not be started ({type(e).__name__}).") from e
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.warning("could not delete a temporary OCR image")


# ---------------------------------------------------------------- extraction
@dataclass
class ExtractResult:
    pages: list[str] = field(default_factory=list)       # text per page (OCR text for scanned pages); pages never reached are absent
    page_count: int = 0
    method: Optional[str] = None                          # text | ocr | mixed
    ocr_pages: int = 0
    error_code: Optional[str] = None
    error_message: Optional[str] = None


def _visible(text: str) -> int:
    return sum(1 for ch in text if not ch.isspace())


def _render_page(page) -> tuple[bytes, bool]:
    """(PNG of the page for OCR, whether the page is blank). Rendered in grayscale at ~300 DPI, longest side capped."""
    w_pt, h_pt = page.get_size()
    scale = min(OCR_DPI / 72.0, OCR_MAX_SIDE_PX / max(w_pt, h_pt, 1.0))
    bitmap = page.render(scale=scale, grayscale=True)
    try:
        raw = bytes(bitmap.buffer)
        sample = raw[:: 97]                                   # a sparse sample is enough to tell an empty page from a scan
        dark = sum(1 for b in sample if b < 200)
        return png_bytes(raw, bitmap.width, bitmap.height, bitmap.stride), dark <= max(2, len(sample) // 2000)
    finally:
        bitmap.close()


def extract_pages(data: bytes, settings: Settings, *, progress: Optional[Callable[[str, str], None]] = None,
                  cancelled: Callable[[], bool] = lambda: False,
                  ocr: Optional[Callable[[bytes], str]] = None, tesseract: Optional[str] = None) -> ExtractResult:
    """Text of every page. Scanned pages are OCR'd when Tesseract is available. `progress(status, detail)` reports each step.

    `ocr` replaces the Tesseract call (tests). Errors are returned in the result (with whatever text was already read), never raised,
    except PdfError for a file that cannot be opened at all."""
    doc = open_pdf(data)
    res = ExtractResult()
    try:
        n = res.page_count = len(doc)
        texts: list[Optional[str]] = []
        for i in range(n):
            if cancelled():
                break
            page = doc[i]
            try:
                tp = page.get_textpage()
                try:
                    texts.append(tp.get_text_bounded() or "")
                finally:
                    tp.close()
            finally:
                page.close()
            if progress:
                progress("extracting", f"page {i + 1} of {n}")
        scanned = [i for i, t in enumerate(texts) if _visible(t or "") < SCANNED_PAGE_CHARS]
        images: dict[int, bytes] = {}
        for i in scanned:                                      # a truly empty page (often the last one) needs no OCR
            if cancelled():
                break
            page = doc[i]
            try:
                png, blank = _render_page(page)
            finally:
                page.close()
            if not blank:
                images[i] = png
        need_ocr = [i for i in scanned if i in images]
        if need_ocr and not cancelled():
            runner = ocr
            if runner is None:
                st = ocr_status(settings)
                exe = tesseract or (st["path"] if st["available"] else None)
                if not exe:
                    res.pages = [t or "" for t in texts]
                    res.method = "text"
                    res.error_code = "ocr_unavailable"
                    pages_txt = "1 page" if len(need_ocr) == 1 else f"{len(need_ocr)} pages"
                    why = "OCR is turned off (OCR_ENABLED=0)" if not settings.ocr_enabled else "the free OCR program Tesseract is not installed"
                    res.error_message = (f"{pages_txt} of this PDF {'is a scanned image' if len(need_ocr) == 1 else 'are scanned images'} and {why}. "
                                         f"Install it with: {install_hint()}  then press Try again. The text that could be read is kept.")
                    return res
                runner = lambda png, _exe=exe: ocr_png(png, settings, _exe)  # noqa: E731
            for k, i in enumerate(need_ocr, start=1):
                if cancelled():
                    break
                if progress:
                    progress("ocr", f"page {k} of {len(need_ocr)}")
                try:
                    texts[i] = runner(images.pop(i))
                except OcrError as e:
                    res.pages = [t or "" for t in texts]
                    res.error_code, res.error_message = e.code, e.message + " The text that could be read is kept; press Try again."
                    return res
                res.ocr_pages += 1
        res.pages = [t or "" for t in texts]
        text_pages = n - len(scanned)
        res.method = "text" if res.ocr_pages == 0 else ("ocr" if text_pages == 0 else "mixed")
        if not cancelled() and _visible("".join(res.pages)) < MIN_DOCUMENT_CHARS:
            res.error_code = "no_text"
            res.error_message = ("Almost no text could be read from this PDF. If it is a photo or scan, make sure it is sharp and upright; "
                                 "or export your resume again as a text PDF. You can also fill in the content yourself.")
        return res
    finally:
        doc.close()


# ---------------------------------------------------------------- clean-up
_BULLETS = "•●▪■◦‣∙○◆◇►▸➢➤✓✔·*¢»"          # ¢ and » are how OCR often reads a round bullet
_BULLET_RE = re.compile(rf"^[ \t]*(?:[{re.escape(_BULLETS)}]|[-–—](?=\s))[ \t]*")
_PAGE_NUM_RE = re.compile(r"^\s*(?:page\s*)?\d{1,3}(?:\s*(?:of|/)\s*\d{1,3})?\s*$", re.I)
_INVISIBLE = dict.fromkeys(map(ord, "\u00ad\u200b\u200c\u200d\ufeff\u2060"), None)


def _norm_line(line: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", line.strip().lower()))


def _repeated_edges(pages: list[list[str]]) -> set[str]:
    """Header/footer lines: the same (digits-normalised) line among the first/last two lines of most pages."""
    if len(pages) < 2:
        return set()
    seen: Counter[str] = Counter()
    for lines in pages:
        nonblank = [ln for ln in lines if ln.strip()]
        for ln in set(_norm_line(x) for x in nonblank[:2] + nonblank[-2:]):
            if ln and len(ln) <= 120:
                seen[ln] += 1
    need = max(2, (len(pages) + 1) // 2)
    return {ln for ln, k in seen.items() if k >= need}


def clean_text(pages: list[str], limit: int = MAX_TEXT_CHARS) -> tuple[str, bool]:
    """Normalise unicode and whitespace, join words hyphenated across lines, drop repeated headers/footers and page numbers,
    unify bullet characters to "•", and keep "--- page N ---" markers. Returns (text, truncated)."""
    split: list[list[str]] = []
    for raw in pages:
        t = unicodedata.normalize("NFKC", (raw or "").translate(_INVISIBLE)).replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n")
        t = t.replace("\t", " ")
        split.append(t.split("\n"))
    edges = _repeated_edges(split)
    out_pages = []
    for lines in split:
        kept = []
        nonblank = [k for k, ln in enumerate(lines) if ln.strip()]
        edge_pos = set(nonblank[:2] + nonblank[-2:])            # only the top and bottom lines of a page can be a header or footer
        for k, ln in enumerate(lines):
            if _PAGE_NUM_RE.match(ln) or (k in edge_pos and _norm_line(ln) in edges):
                continue
            ln = _BULLET_RE.sub("• ", ln) if _BULLET_RE.match(ln) else ln
            kept.append(re.sub(r"[ \u00a0]{2,}", " ", ln).rstrip())
        text = "\n".join(kept)
        text = re.sub(r"(\w)-\n[ ]*([a-z])", r"\1\2", text)          # devel-\nopment -> development (only before a lowercase letter)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        out_pages.append(text)
    body = "\n\n".join(f"--- page {i} ---\n{t}" for i, t in enumerate(out_pages, start=1))
    if len(body) > limit:
        cut = body.rfind("\n", 0, limit)
        return body[: cut if cut > limit * 0.8 else limit].rstrip(), True
    return body, False


def strip_page_markers(text: str) -> str:
    return re.sub(r"^--- page \d+ ---\n?", "", text, flags=re.M).strip()
