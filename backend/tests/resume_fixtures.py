"""PDF fixtures for the resume tests, generated on the fly (reportlab for text PDFs; a hand-written image-only PDF for 'scans')."""
from __future__ import annotations

import io
import zlib
from typing import Optional

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

RESUME_LINES = [
    "Jane Doe", "jane.doe@example.com · +1 555 0100 · Berlin", "",
    "SUMMARY", "Backend engineer with 6 years of experience building data platforms.", "",
    "EXPERIENCE",
    "Senior Backend Engineer — Acme Corp, Berlin   Mar 2021 – Present",
    "• Cut p95 API latency by 40% by moving hot reads to Redis",
    "• Led the migration of 30 services from a monolith to Kubernetes",
    "• Mentored 4 engineers and ran the on-call rotation",
    "Software Engineer — Globex, Munich   Jan 2018 – Jun 2020",
    "• Built a Kafka pipeline processing 2M events per day",
    "• Wrote the billing reconciliation service in Go", "",
    "PROJECTS",
    "Open-source rate limiter (Go, Redis) — token bucket library with 1.2k GitHub stars", "",
    "SKILLS", "Languages: Python, Go, SQL", "Cloud: AWS, Kubernetes, Terraform", "",
    "EDUCATION", "TU Munich — MSc Computer Science, 2016 – 2018",
]


def text_pdf(lines: list[str] = RESUME_LINES, pages: int = 1, *, encrypt: Optional[str] = None, header: Optional[str] = None) -> bytes:
    buf = io.BytesIO()
    kw = {}
    if encrypt:
        from reportlab.lib import pdfencrypt
        kw["encrypt"] = pdfencrypt.StandardEncryption(encrypt, canPrint=0)
    c = canvas.Canvas(buf, pagesize=A4, **kw)
    per = max(1, -(-len(lines) // pages))
    for p in range(pages):
        y = 800
        if header:
            c.drawString(60, 820, header)
        for line in lines[p * per:(p + 1) * per]:
            c.drawString(60, y, line)
            y -= 16
        c.drawString(290, 30, str(p + 1))
        c.showPage()
    c.save()
    return buf.getvalue()


def two_column_pdf() -> bytes:
    """Skills in a narrow left column, experience in a wide right column (a typical template)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    left = ["SKILLS", "Python", "Kafka", "PostgreSQL", "", "EDUCATION", "MIT — BSc Physics 2015"]
    right = ["EXPERIENCE", "Data Engineer — Initech  2019 – Present", "• Reduced warehouse cost by 25% with partition pruning",
             "• Designed CDC ingestion for 120 tables", "Analyst — Umbrella  2015 – 2019", "• Automated weekly reporting in Python"]
    for i, line in enumerate(left):
        c.drawString(40, 800 - 16 * i, line)
    for i, line in enumerate(right):
        c.drawString(230, 800 - 16 * i, line)
    c.showPage()
    c.save()
    return buf.getvalue()


def _render_gray(pdf: bytes, scale: float = 2.0) -> list[tuple[int, int, bytes]]:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    out = []
    for i in range(len(doc)):
        page = doc[i]
        bm = page.render(scale=scale, grayscale=True)
        raw = bytes(bm.buffer)
        rows = b"".join(raw[y * bm.stride: y * bm.stride + bm.width] for y in range(bm.height))
        out.append((bm.width, bm.height, rows))
        bm.close()
        page.close()
    doc.close()
    return out


def image_pdf(images: list[tuple[int, int, bytes]]) -> bytes:
    """A PDF whose pages contain ONLY a grayscale image (no text layer) - exactly what a scanner produces."""
    objs: list[bytes] = []
    kids = []
    n = len(images)
    # 1 catalog, 2 pages, then per page: page, content, image
    for i, (w, h, rows) in enumerate(images):
        page_no, content_no, img_no = 3 + 3 * i, 4 + 3 * i, 5 + 3 * i
        kids.append(f"{page_no} 0 R")
        pw, ph = 595, 842
        content = f"q {pw} 0 0 {ph} 0 0 cm /Im{i} Do Q".encode()
        data = zlib.compress(rows)
        objs.append((page_no, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Resources << /XObject << /Im{i} {img_no} 0 R >> >> /Contents {content_no} 0 R >>".encode()))
        objs.append((content_no, b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"))
        objs.append((img_no, f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"))
    all_objs = [(1, b"<< /Type /Catalog /Pages 2 0 R >>"), (2, f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {n} >>".encode())] + objs
    all_objs.sort()
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num, body in all_objs:
        offsets[num] = out.tell()
        out.write(f"{num} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    size = len(all_objs) + 1
    out.write(f"xref\n0 {size}\n0000000000 65535 f \n".encode())
    for num in range(1, size):
        out.write(f"{offsets[num]:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def scanned_pdf(lines: list[str] = RESUME_LINES, pages: int = 1) -> bytes:
    """Render a text resume to pixels and wrap the pixels in an image-only PDF."""
    return image_pdf(_render_gray(text_pdf(lines, pages), scale=2.5))


def mixed_pdf() -> bytes:
    """Page 1 has a text layer, page 2 is a scan."""
    import pypdfium2 as pdfium
    first = text_pdf(RESUME_LINES[:12])
    second = scanned_pdf(RESUME_LINES[12:])
    dst = pdfium.PdfDocument.new()
    for src in (first, second):
        d = pdfium.PdfDocument(src)
        dst.import_pages(d)
    buf = io.BytesIO()
    dst.save(buf)
    return buf.getvalue()


def profile_reply(**over) -> dict:
    """What a well-behaved model returns for one part of RESUME_LINES."""
    base = {
        "contact": {"name": "Jane Doe", "email": "jane.doe@example.com", "phone": "+1 555 0100", "location": "Berlin", "links": []},
        "summary": "Backend engineer with 6 years of experience building data platforms.",
        "skills": [{"group": "Languages", "items": ["Python", "Go", "SQL"]}, {"group": "Cloud", "items": ["AWS", "Kubernetes", "Terraform"]}],
        "experience": [
            {"company": "Acme Corp", "title": "Senior Backend Engineer", "location": "Berlin", "start": "Mar 2021", "end": "Present", "is_current": True,
             "bullets": ["Cut p95 API latency by 40% by moving hot reads to Redis", "Led the migration of 30 services from a monolith to Kubernetes",
                         "Mentored 4 engineers and ran the on-call rotation"]},
            {"company": "Globex", "title": "Software Engineer", "location": "Munich", "start": "Jan 2018", "end": "Jun 2020", "is_current": False,
             "bullets": ["Built a Kafka pipeline processing 2M events per day", "Wrote the billing reconciliation service in Go"]},
        ],
        "projects": [{"name": "Open-source rate limiter", "role": "", "tech": ["Go", "Redis"], "link": "", "bullets": ["Token bucket library with 1.2k GitHub stars"]}],
        "education": [{"school": "TU Munich", "degree": "MSc", "field": "Computer Science", "start": "2016", "end": "2018", "details": ""}],
        "certifications": [], "achievements": [], "other": [],
    }
    base.update(over)
    return base
