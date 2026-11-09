#!/usr/bin/env python3
"""Cross-platform launcher for AI Interviewer (macOS, Windows, Linux). Standard library only.

    start [--dev] [--open]   start Ollama (if needed) and the app on http://localhost:3000
    stop [--unload]          stop the app (--unload also frees the model's memory)
    check                    verify prerequisites (read-only; installs and downloads nothing)
    setup-models [--stt] [-y]  download only the models this app needs, after asking

Normally you run it through start.sh / stop.sh / check.sh / setup-models.sh (macOS, Linux)
or start.bat / stop.bat / check.bat / setup-models.bat (Windows).
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
RUN_DIR, LOG_DIR = ROOT / ".run", ROOT / "logs"
BACKEND, FRONTEND = ROOT / "backend", ROOT / "frontend"
WINDOWS = os.name == "nt"
MAC = sys.platform == "darwin"
APPLE_SILICON = MAC and platform.machine() == "arm64"
VENV = BACKEND / ".venv"


def venv_python(windows: bool, venv: Path = VENV) -> Path:
    return venv / ("Scripts/python.exe" if windows else "bin/python")


VENV_PY = venv_python(WINDOWS)
SCRIPT = "setup-models.bat" if WINDOWS else "./setup-models.sh"

# ------------------------------------------------------------------ output
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if WINDOWS:
    os.system("")  # switches the console to ANSI colour mode (Windows 10+)
_TTY = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
_C = {"g": "\033[32m", "r": "\033[31m", "y": "\033[33m", "b": "\033[1m", "n": "\033[0m"} if _TTY else dict.fromkeys("grybn", "")
_SYM = ("+", "!", "x") if WINDOWS else ("✓", "!", "✗")


def ok(msg: str) -> None: print(f"{_C['g']}{_SYM[0]}{_C['n']} {msg}")
def warn(msg: str) -> None: print(f"{_C['y']}{_SYM[1]}{_C['n']} {msg}")
def bad(msg: str) -> None: print(f"{_C['r']}{_SYM[2]}{_C['n']} {msg}")
def info(msg: str = "") -> None: print(msg)
def bold(msg: str) -> str: return f"{_C['b']}{msg}{_C['n']}"


# ------------------------------------------------------------------ configuration (.env, same rules as the backend)
def parse_env_value(raw: str) -> str:
    v = raw.strip()
    if v[:1] in {'"', "'"}:
        end = v.find(v[0], 1)
        return v[1:end] if end > 0 else v[1:]
    cut = v.find(" #")
    return (v[:cut] if cut >= 0 else v).strip()


def load_env() -> None:
    f = ROOT / ".env"
    if not f.is_file():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), parse_env_value(v))


load_env()
APP_HOST = os.environ.get("APP_HOST", "127.0.0.1")
OLLAMA_URL = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.5:4b")
TTS_MODEL = os.environ.get("TTS_MODEL", "phonon")
TTS_PROVIDER = (os.environ.get("TTS_PROVIDER", "auto").strip().lower() or "auto")
STT_MODEL = os.environ.get("STT_MODEL", "base.en")
try:
    APP_PORT = int(os.environ.get("APP_PORT", "3000"))
except ValueError:
    APP_PORT = 3000


def wants_phonon() -> bool:
    """Phonon (the premium voice) runs on Apple Silicon only; everywhere else the browser's offline voices are used."""
    return TTS_PROVIDER == "phonon" or (TTS_PROVIDER == "auto" and APPLE_SILICON)


# ------------------------------------------------------------------ small system helpers
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # loopback must never go through an HTTP proxy


def http(url: str, *, data: Optional[dict] = None, timeout: float = 2.0) -> Optional[bytes]:
    try:
        req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json"} if data is not None else {})
        with _NO_PROXY.open(req, timeout=timeout) as r:
            return r.read()
    except Exception:
        return None


def port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.6)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ollama_up() -> bool:
    return http(f"{OLLAMA_URL}/api/version") is not None


def installed_models() -> set[str]:
    raw = http(f"{OLLAMA_URL}/api/tags", timeout=5)
    if raw is None:
        return set()
    try:
        return {m.get("name", "") for m in json.loads(raw).get("models", [])}
    except ValueError:
        return set()


def have_model(names: set[str], model: str) -> bool:
    return model in names or f"{model}:latest" in names


def free_gb() -> float:
    return shutil.disk_usage(ROOT).free / 2**30


def total_ram_gb() -> Optional[float]:
    try:
        if MAC:
            return int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) / 2**30
        if WINDOWS:
            import ctypes

            class MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            m = MemStatus()
            m.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))  # type: ignore[attr-defined]
            return m.ullTotalPhys / 2**30
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) / 2**20
    except Exception:
        return None
    return None


def os_label() -> str:
    if MAC:
        return f"macOS {platform.mac_ver()[0]} ({platform.machine()})"
    if WINDOWS:
        return f"Windows {platform.release()} ({platform.machine()})"
    return f"{platform.system()} {platform.release()} ({platform.machine()})"


def install_hint(what: str) -> str:
    if MAC:
        return {"node": "brew install node", "python": "brew install python", "ollama": "https://ollama.com/download"}[what]
    if WINDOWS:
        return {"node": "winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)", "python": "winget install Python.Python.3.12  (or https://python.org)",
                "ollama": "https://ollama.com/download/windows"}[what]
    return {"node": "your package manager, e.g. sudo apt install nodejs npm  (or https://nodejs.org)",
            "python": "your package manager, e.g. sudo apt install python3 python3-venv",
            "ollama": "curl -fsSL https://ollama.com/install.sh | sh"}[what]


def find_ollama() -> Optional[str]:
    found = shutil.which("ollama")
    if found:
        return found
    candidates: list[Path] = []
    if WINDOWS:
        candidates.append(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe")
    elif MAC:
        candidates += [Path("/Applications/Ollama.app/Contents/Resources/ollama"), Path("/opt/homebrew/bin/ollama"), Path("/usr/local/bin/ollama")]
    else:
        candidates += [Path("/usr/local/bin/ollama"), Path("/usr/bin/ollama")]
    return next((str(c) for c in candidates if c.is_file()), None)


def node_major() -> Optional[int]:
    node = shutil.which("node")
    if not node:
        return None
    try:
        return int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True, timeout=15).strip())
    except Exception:
        return None


# ------------------------------------------------------------------ processes
def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if WINDOWS:
        import ctypes

        k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        got = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(got) and code.value == 259  # STILL_ACTIVE
    try:
        if os.waitpid(pid, os.WNOHANG)[0]:   # our own child that already exited (a zombie) is not alive
            return False
    except ChildProcessError:                # not our child: the normal case when `stop` runs in a new process
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def cmdline(pid: int) -> Optional[str]:
    """Command line of a process, or None if it cannot be determined."""
    try:
        if WINDOWS:
            cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                   f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
        else:
            out = subprocess.run(["ps", "-p", str(int(pid)), "-o", "command="], capture_output=True, text=True, timeout=5).stdout
        return out.strip().lower() or None
    except Exception:
        return None


def is_ours(pid: int, *needles: str) -> Optional[bool]:
    """True/False if we can tell whether `pid` is one of our processes (guards against a recycled PID), None if unknown."""
    cl = cmdline(pid)
    return None if cl is None else any(n in cl for n in needles)


def read_pid(name: str) -> Optional[int]:
    try:
        return int((RUN_DIR / f"{name}.pid").read_text().strip())
    except (OSError, ValueError):
        return None


def write_pid(name: str, pid: int) -> None:
    RUN_DIR.mkdir(exist_ok=True)
    (RUN_DIR / f"{name}.pid").write_text(str(pid))


def drop_pid(name: str) -> None:
    (RUN_DIR / f"{name}.pid").unlink(missing_ok=True)


def spawn(cmd: list[str], log_name: str, cwd: Path, env: Optional[dict] = None) -> int:
    """Start a detached background process (survives closing the terminal) logging to logs/<log_name>."""
    LOG_DIR.mkdir(exist_ok=True)
    kw: dict = {}
    if WINDOWS:
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    with open(LOG_DIR / log_name, "ab") as log:
        proc = subprocess.Popen(cmd, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, **kw)
    return proc.pid


def _wait_gone(pid: int, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline and pid_alive(pid):
        time.sleep(0.1)
    return not pid_alive(pid)


def terminate(pid: int, grace: float = 3.0) -> None:
    """Stop a process we started and everything it spawned."""
    if WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)   # /T = the whole tree
        _wait_gone(pid, grace)
        return
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 1.0)):
        try:
            os.killpg(pid, sig)          # the process leads its own session (see spawn), so this reaches its children too
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return
        if _wait_gone(pid, wait):
            return


def api_health(port: int) -> bool:
    return http(f"http://127.0.0.1:{port}/api/health") is not None


# ------------------------------------------------------------------ start
def python_ok() -> bool:
    return sys.version_info >= (3, 10)


def venv_ready() -> bool:
    if not VENV_PY.is_file():
        return False
    return subprocess.run([str(VENV_PY), "-c", "import fastapi,uvicorn,httpx,pydantic,multipart,reportlab,pypdfium2"], capture_output=True).returncode == 0


def pip_install(req: Path) -> None:
    uv = shutil.which("uv")
    if uv:
        subprocess.run([uv, "pip", "install", "-q", "--python", str(VENV_PY), "-r", str(req)], check=True)
    else:
        subprocess.run([str(VENV_PY), "-m", "pip", "install", "-q", "-r", str(req)], check=True)


def ensure_backend_env() -> bool:
    if venv_ready():
        return True
    if VENV_PY.is_file():       # an older install that lacks a newer dependency (e.g. the PDF writer): top it up in place, keep everything else
        info("Updating backend dependencies (one-time, needs internet)...")
        try:
            pip_install(BACKEND / "requirements.txt")
        except (subprocess.CalledProcessError, OSError) as e:
            bad(f"Could not update the Python environment: {e}")
            return False
        return venv_ready()
    info("Installing backend dependencies (one-time, needs internet)...")
    try:
        uv = shutil.which("uv")
        if uv:
            if subprocess.run([uv, "venv", str(VENV), "--python", sys.executable, "-q"], capture_output=True).returncode != 0:
                subprocess.run([uv, "venv", str(VENV), "-q"], check=True)
        else:
            subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        pip_install(BACKEND / "requirements.txt")
    except (subprocess.CalledProcessError, OSError) as e:
        bad(f"Could not set up the Python environment: {e}")
        if not WINDOWS and not MAC:
            info("  On Debian/Ubuntu you may need:  sudo apt install python3-venv")
        return False
    return True


def frontend_stale() -> bool:
    built = FRONTEND / "dist" / "index.html"
    if not built.is_file():
        return True
    stamp = built.stat().st_mtime
    watched = [FRONTEND / "index.html", FRONTEND / "package.json"]
    for folder in ("src", "public"):
        watched += [p for p in (FRONTEND / folder).rglob("*") if p.is_file()]
    return any(p.stat().st_mtime > stamp for p in watched if p.exists())


CLOUD_HINT = "Cloud mode (Settings -> AI models) works without it."


def ensure_ollama() -> bool:
    """Start the local Ollama if there is one. It is OPTIONAL: it runs the local model and the Phonon voice, but the app also works with
    Ollama's cloud models (and this computer's own voices), so a missing or broken Ollama is a warning, never a reason to refuse to start."""
    if ollama_up():
        ok("Ollama is running")
        return True
    exe = find_ollama()
    if not exe:
        warn(f"Ollama is not installed ({install_hint('ollama')}). The local model and the Phonon voice are unavailable. {CLOUD_HINT}")
        return False
    if os.environ.get("OLLAMA_AUTOSTART", "1").strip() == "0":
        info("Ollama is installed but not running, and OLLAMA_AUTOSTART=0, so it is left alone (the app will say so).")
        return False
    info("Starting Ollama...")
    write_pid("ollama", spawn([exe, "serve"], "ollama.log", ROOT))
    for _ in range(30):
        if ollama_up():
            ok("Ollama started")
            return True
        time.sleep(1)
    warn(f"Ollama did not start - see logs/ollama.log. {CLOUD_HINT}")
    return False


def setup_help_url(need: str) -> str:
    return (ROOT / "scripts" / "setup-required.html").as_uri() + f"?need={need}"


def open_setup_help(need: str) -> None:
    """A tool the app is built with is missing, so there is no app page to show yet: open the plain 'install this' page that ships with the app."""
    if os.environ.get("LAI_NO_BROWSER"):
        return
    info("Opening a page with install steps for your computer...")
    try:
        webbrowser.open(setup_help_url(need))
    except Exception:       # the message above is enough
        pass


def cmd_start(args: argparse.Namespace) -> int:
    dev = args.dev
    if APP_HOST not in {"127.0.0.1", "localhost", "::1"}:
        bad(f"APP_HOST={APP_HOST} is not loopback. Refusing (local-only app).")
        return 1
    api_port = 8000 if dev else APP_PORT

    existing = read_pid("backend")
    if existing and pid_alive(existing):
        if api_health(APP_PORT) or api_health(8000):
            ok(f"Already running (pid {existing}). Open http://localhost:{APP_PORT}")
            return 0
    drop_pid("backend")
    drop_pid("frontend")
    for p in sorted({APP_PORT, api_port}):
        if port_busy(p):
            bad(f"Port {p} is already in use by another program. Free it or set APP_PORT in .env.")
            if WINDOWS:
                info(f"  Find it with:  netstat -ano | findstr :{p}")
            else:
                info(f"  Find it with:  lsof -nP -iTCP:{p} -sTCP:LISTEN")
            return 1

    if not python_ok():
        bad(f"Python 3.10 or newer is required (this is {platform.python_version()}): {install_hint('python')}")
        return 1
    major = node_major()
    if major is None or not shutil.which("npm"):
        bad(f"Node.js 18 or newer is required: {install_hint('node')}")
        open_setup_help("node")
        return 1
    if major < 18:
        bad(f"Node.js 18 or newer is required (found {major}): {install_hint('node')}")
        open_setup_help("node")
        return 1
    npm = shutil.which("npm") or "npm"

    if not ensure_backend_env():
        return 1
    if not (FRONTEND / "node_modules").is_dir():
        info("Installing frontend dependencies (one-time, needs internet)...")
        if subprocess.run([npm, "install", "--no-audit", "--no-fund", "--loglevel=error"], cwd=FRONTEND).returncode != 0:
            bad("npm install failed")
            return 1
    if not dev and frontend_stale():
        info("Building the frontend...")
        LOG_DIR.mkdir(exist_ok=True)
        with open(LOG_DIR / "frontend-build.log", "wb") as log:
            built = subprocess.run([npm, "run", "build", "--silent"], cwd=FRONTEND, stdout=log, stderr=subprocess.STDOUT).returncode == 0
        if not built:
            bad("Frontend build failed - see logs/frontend-build.log")
            return 1

    if ensure_ollama():
        names = installed_models()
        if not have_model(names, LLM_MODEL):
            warn(f"Model {LLM_MODEL} is missing -> run {SCRIPT} (shows sizes, asks first). Local interviews need it; {CLOUD_HINT}")
        if wants_phonon() and not have_model(names, TTS_MODEL):
            warn(f"Premium voice {TTS_MODEL} is not installed -> using this computer's own voices. Run {SCRIPT} to add it.")

    env = {**os.environ, "HF_HUB_OFFLINE": "1", "APP_HOST": APP_HOST, "APP_PORT": str(APP_PORT), "OLLAMA_HOST_URL": OLLAMA_URL,
           "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"}
    pid = spawn([str(VENV_PY), "-m", "uvicorn", "app.main:app_factory", "--factory", "--host", "127.0.0.1", "--port", str(api_port),
                 "--log-level", "warning", "--no-server-header"], "backend.log", BACKEND, env)
    write_pid("backend", pid)
    for _ in range(40):
        if api_health(api_port) or not pid_alive(pid):
            break
        time.sleep(0.5)
    if not api_health(api_port):
        bad("Backend failed to start. Last log lines:")
        try:
            for line in (LOG_DIR / "backend.log").read_text(errors="replace").splitlines()[-15:]:
                info("  " + line)
        except OSError:
            pass
        drop_pid("backend")
        return 1

    if dev:
        vite = FRONTEND / "node_modules" / "vite" / "bin" / "vite.js"
        write_pid("frontend", spawn([shutil.which("node") or "node", str(vite), "--host", "127.0.0.1", "--port", str(APP_PORT), "--strictPort"],
                                    "frontend.log", FRONTEND, env))
        time.sleep(2)

    url = f"http://localhost:{APP_PORT}"
    ok("Ready (all processing is local; bound to 127.0.0.1 only)")
    stop_cmd = "stop.bat" if WINDOWS else "./stop.sh"
    info(f"\n  {bold('Open in Chrome or Edge:')}  {url}\n\n  Logs: logs/backend.log   Stop: {stop_cmd}\n")
    if args.open:
        import webbrowser

        webbrowser.open(url)
    return 0


# ------------------------------------------------------------------ stop
def stop_one(name: str, label: str, *needles: str, health_port: Optional[int] = None) -> None:
    pid = read_pid(name)
    if pid is None:
        return
    if pid_alive(pid):
        verdict = is_ours(pid, *needles)
        if verdict is None and health_port is not None:
            verdict = api_health(health_port)            # cannot inspect the process: trust the app answering on its port
        if verdict:
            terminate(pid)
            ok(f"Stopped {label}")
        else:
            warn(f"Process {pid} is not {label} any more (stale PID file); leaving it alone.")
    drop_pid(name)


def cmd_stop(args: argparse.Namespace) -> int:
    stop_one("frontend", "frontend dev server", "vite")
    stop_one("backend", "backend", "uvicorn", health_port=APP_PORT if api_health(APP_PORT) else 8000)
    if args.unload and ollama_up():
        if http(f"{OLLAMA_URL}/api/generate", data={"model": LLM_MODEL, "keep_alive": 0}, timeout=10) is not None:
            ok(f"Unloaded {LLM_MODEL} from memory")
    if read_pid("ollama") is not None:
        stop_one("ollama", "Ollama (started by this app)", "ollama")
    else:
        info("Ollama left running (it was not started by this app).")
    return 0


# ------------------------------------------------------------------ check
def stt_ready() -> bool:
    code = ("import os,sys\nos.environ['HF_HUB_OFFLINE']='1'\n"
            "from faster_whisper.utils import _MODELS\nfrom huggingface_hub import try_to_load_from_cache\n"
            f"m=_MODELS.get({STT_MODEL!r},{STT_MODEL!r})\n"
            "sys.exit(0 if isinstance(try_to_load_from_cache(m,'model.bin'),str) else 1)")
    return subprocess.run([str(VENV_PY), "-c", code], capture_output=True).returncode == 0


def cmd_check(_: argparse.Namespace) -> int:
    fail = 0
    ok(os_label())
    ram = total_ram_gb()
    info(f"  RAM: {ram:.0f} GB, free disk: {free_gb():.0f} GB" if ram else f"  free disk: {free_gb():.0f} GB")
    if ram and ram < 7:
        warn(f"Only {ram:.0f} GB RAM: {LLM_MODEL} needs about 4.5 GB free. Close other apps, or pick a smaller LLM_MODEL in .env.")
    if wants_phonon() and not APPLE_SILICON:
        warn("TTS_PROVIDER=phonon needs an Apple Silicon Mac; use TTS_PROVIDER=auto here.")
    info(f"  Voice: {'Phonon (Apple Silicon) if installed, otherwise ' if APPLE_SILICON else ''}this computer's offline voices through the browser")

    major = node_major()
    if major is None:
        bad(f"Node.js not found: {install_hint('node')}")
        fail = 1
    elif major < 18:
        bad(f"Node >= 18 required (found {major})")
        fail = 1
    else:
        ok(f"Node {major}.x")
    if python_ok():
        ok(f"Python {platform.python_version()} ({sys.executable})")
    else:
        bad(f"Python >= 3.10 required (this is {platform.python_version()}): {install_hint('python')}")
        fail = 1

    if venv_ready():
        ok("Backend dependencies installed")
    else:
        warn("Backend dependencies not installed yet (start installs them: needs internet once)")
    if (FRONTEND / "node_modules").is_dir():
        ok("Frontend dependencies installed")
    else:
        warn("Frontend dependencies not installed yet (start installs them: needs internet once)")
    if (FRONTEND / "dist" / "index.html").is_file():
        ok("Frontend built")
    else:
        warn("Frontend not built yet (start builds it)")

    exe = find_ollama()
    if not exe:
        warn(f"Ollama not installed ({install_hint('ollama')}). Needed only for the local model and the Phonon voice. {CLOUD_HINT}")
    else:
        ok(f"Ollama installed ({exe})")
        if ollama_up():
            ok(f"Ollama server reachable at {OLLAMA_URL}")
            names = installed_models()
            if have_model(names, LLM_MODEL):
                ok(f"LLM model {LLM_MODEL} installed")
            else:
                warn(f"LLM model {LLM_MODEL} missing -> run {SCRIPT} (needed for local mode only; {CLOUD_HINT})")
            if wants_phonon():
                if have_model(names, TTS_MODEL):
                    ok(f"Premium voice {TTS_MODEL} installed")
                else:
                    warn(f"Premium voice {TTS_MODEL} missing -> run {SCRIPT} (optional: the system voices work without it)")
        else:
            warn("Ollama is installed but not running (start will launch it)")

    if VENV_PY.is_file():
        if stt_ready():
            ok(f"Optional microphone model '{STT_MODEL}' ready")
        else:
            warn(f"Optional microphone (speech-to-text) not set up -> {SCRIPT} --stt")
    tess = find_tesseract()
    if tess:
        ok(f"Optional resume OCR (Tesseract) found ({tess})")
    else:
        info(f"  Optional resume OCR (Tesseract) not installed -> {TESSERACT_INSTALL.get(os_key(), TESSERACT_INSTALL['linux'])}  (only needed for scanned resume PDFs)")
    if free_gb() < 8:
        warn("Less than 8 GB free disk")
    return fail


TESSERACT_INSTALL = {"macos": "brew install tesseract", "windows": "winget install UB-Mannheim.TesseractOCR", "linux": "sudo apt install tesseract-ocr"}


def find_tesseract() -> str | None:
    """Same search as the backend (TESSERACT_CMD, PATH, the installers' default folders). Read-only."""
    override = (os.environ.get("TESSERACT_CMD") or "").strip()
    if override:
        return override if Path(override).is_file() else None
    found = shutil.which("tesseract")
    if found:
        return found
    if WINDOWS:
        cands = [r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]
    elif sys.platform == "darwin":
        cands = ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "/opt/local/bin/tesseract"]
    else:
        cands = ["/usr/bin/tesseract", "/usr/local/bin/tesseract", "/snap/bin/tesseract"]
    return next((c for c in cands if Path(c).is_file()), None)


def os_key() -> str:
    return "windows" if WINDOWS else "macos" if sys.platform == "darwin" else "linux"


# ------------------------------------------------------------------ setup-models
def cmd_setup(args: argparse.Namespace) -> int:
    exe = find_ollama()
    if not exe:
        bad(f"Ollama is not installed. Install it from {install_hint('ollama')} then run this again.")
        return 1
    if not ollama_up():
        warn("Starting Ollama server...")
        write_pid("ollama", spawn([exe, "serve"], "ollama.log", ROOT))
        for _ in range(30):
            if ollama_up():
                break
            time.sleep(1)
        if not ollama_up():
            bad("Could not start Ollama")
            return 1

    names = installed_models()
    todo: list[tuple[str, str, int]] = []   # (model, size text, GB needed)
    if have_model(names, LLM_MODEL):
        ok(f"{LLM_MODEL} already installed (skipping)")
    else:
        todo.append((LLM_MODEL, "~3.3-4.0 GB on disk (runs in roughly 3.5-4.5 GB of RAM)", 5))
    if wants_phonon():
        if have_model(names, TTS_MODEL):
            ok(f"{TTS_MODEL} already installed (skipping)")
        else:
            todo.append((TTS_MODEL, "~0.1 GB (premium voice, Apple Silicon only)", 1))
    else:
        info(f"- Premium voice {TTS_MODEL} skipped: it needs an Apple Silicon Mac. This computer's own offline voices will be used.")
    need = sum(g for _, _, g in todo) + (1 if args.stt else 0)

    if todo or args.stt:
        info(f"\n{bold('Will download (internet required, one time):')}")
        for m, size, _ in todo:
            info(f"  - {m}   {size}")
        if args.stt:
            info(f"  - Whisper '{STT_MODEL}' (faster-whisper)   ~0.15 GB, stored in your Hugging Face cache folder")
        info(f"Free disk: {free_gb():.0f} GB (this needs ~{need} GB).")
        if free_gb() < need:
            bad("Not enough free disk space.")
            return 1
        if not args.yes:
            try:
                reply = input("Proceed? [y/N] ").strip().lower()
            except EOFError:
                reply = ""
            if reply not in {"y", "yes"}:
                info("Cancelled. Nothing was downloaded.")
                return 0

    for m, _, _ in todo:
        info(bold(f"Pulling {m} ..."))
        if subprocess.run([exe, "pull", m]).returncode != 0:
            bad(f"Could not download {m}")
            return 1

    if args.stt:
        if not VENV_PY.is_file():
            bad(f"Run {'start.bat' if WINDOWS else './start.sh'} once first so the Python environment exists.")
            return 1
        info(bold(f"Installing faster-whisper and downloading Whisper '{STT_MODEL}' ..."))
        try:
            pip_install(BACKEND / "requirements-stt.txt")
            code = f"from faster_whisper import WhisperModel; WhisperModel({STT_MODEL!r}, device='cpu', compute_type='int8'); print('downloaded')"
            subprocess.run([str(VENV_PY), "-c", code], check=True, env={**os.environ, "HF_HUB_OFFLINE": "0", "HF_HUB_DISABLE_SYMLINKS_WARNING": "1"})
        except (subprocess.CalledProcessError, OSError) as e:
            bad(f"Microphone model setup failed: {e}")
            return 1
    ok(f"Models ready. Next: {'start.bat' if WINDOWS else './start.sh'}")
    return 0


# ------------------------------------------------------------------ entry point
def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="manage.py", description="AI Interviewer launcher")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start", help="start Ollama (if needed) and the app")
    s.add_argument("--dev", action="store_true", help="Vite dev server with hot reload (developers)")
    s.add_argument("--open", action="store_true", help="open the app in your browser when it is ready")
    s.set_defaults(fn=cmd_start)
    s = sub.add_parser("stop", help="stop the app")
    s.add_argument("--unload", action="store_true", help="also unload the model from memory")
    s.set_defaults(fn=cmd_stop)
    sub.add_parser("check", help="verify prerequisites (read-only)").set_defaults(fn=cmd_check)
    s = sub.add_parser("setup-models", help="download the models this app needs (asks first)")
    s.add_argument("--stt", action="store_true", help="also install offline Whisper for microphone answers")
    s.add_argument("--yes", "-y", action="store_true", help="skip the confirmation prompt")
    s.set_defaults(fn=cmd_setup)
    args = ap.parse_args(argv)
    try:
        return int(args.fn(args) or 0)
    except KeyboardInterrupt:
        info("\nCancelled.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
