#!/usr/bin/env bash
# Finds Python 3.10+ and runs the cross-platform launcher:  scripts/run.sh <start|stop|check|setup-models> [options]
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.10 or newer is required (macOS: brew install python   |   Linux: sudo apt install python3 python3-venv)" >&2
  echo "Opening a page with install steps for your computer..." >&2
  URL="file://$ROOT/scripts/setup-required.html?need=python"
  if [ -z "$LAI_NO_BROWSER" ]; then
    if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi
  fi
  exit 1
fi
exec "$PY" "$ROOT/scripts/manage.py" "$@"
