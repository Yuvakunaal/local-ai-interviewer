"""How much RAM is free right now (used to warn before the 4 GB model is loaded into a nearly full machine).

macOS: `memory_pressure` reports the free percentage the OS itself uses to decide when to swap.
Linux: MemAvailable from /proc/meminfo. Windows: GlobalMemoryStatusEx. Never raises; returns None when unknown.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

_CACHE: tuple[float, Optional[dict[str, float]]] = (0.0, None)
CACHE_SECONDS = 3.0


def parse_memory_pressure(text: str) -> Optional[float]:
    """'System-wide memory free percentage: 32%' -> 0.32"""
    m = re.search(r"free percentage:\s*(\d+)\s*%", text)
    return int(m.group(1)) / 100 if m else None


def parse_meminfo(text: str) -> Optional[tuple[float, float]]:
    """(total_gb, available_gb) from /proc/meminfo text."""
    vals = {k: int(v) for k, v in re.findall(r"^(MemTotal|MemAvailable):\s+(\d+)\s*kB", text, re.M)}
    if "MemTotal" not in vals or "MemAvailable" not in vals:
        return None
    return vals["MemTotal"] / 2**20, vals["MemAvailable"] / 2**20


def _read() -> Optional[dict[str, float]]:
    try:
        if sys.platform == "darwin":
            total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3).stdout.strip()) / 2**30
            free = parse_memory_pressure(subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=3).stdout)
            return None if free is None else {"total_gb": total, "available_gb": total * free}
        if os.name == "nt":
            import ctypes

            class MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            m = MemStatus()
            m.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))  # type: ignore[attr-defined]
            return {"total_gb": m.ullTotalPhys / 2**30, "available_gb": m.ullAvailPhys / 2**30}
        got = parse_meminfo(Path("/proc/meminfo").read_text())
        return None if got is None else {"total_gb": got[0], "available_gb": got[1]}
    except Exception:
        return None


def read_memory() -> Optional[dict[str, float]]:
    global _CACHE
    now = time.monotonic()
    if now - _CACHE[0] < CACHE_SECONDS:
        return _CACHE[1]
    _CACHE = (now, _read())
    return _CACHE[1]


def memory_advice(mem: Optional[dict[str, float]], needs_gb: float, model_loaded: bool, margin_gb: float = 0.5) -> Optional[dict]:
    """What the UI shows. `tight` = the model is not loaded yet and loading it would push other apps into swap (disk)."""
    if not mem:
        return None
    return {"total_gb": round(mem["total_gb"], 1), "available_gb": round(mem["available_gb"], 1), "needs_gb": round(needs_gb, 1),
            "tight": (not model_loaded) and mem["available_gb"] < needs_gb + margin_gb}
