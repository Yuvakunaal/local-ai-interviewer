#!/usr/bin/env bash
# Starts everything: Ollama (if needed) + the app on http://localhost:3000   (macOS / Linux; Windows: start.bat)
#   ./start.sh          production-style: FastAPI serves the built UI (one process)
#   ./start.sh --dev    Vite dev server on :3000 (hot reload) proxying to the API on :8000
#   ./start.sh --open   also open the app in your browser
# Stop with ./stop.sh. Logs are in ./logs.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/run.sh" start "$@"
