#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR/backend"

VENV="$PROJECT_DIR/.venv"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"
pip install -q -r requirements.txt

# The backend imports HuRI's browser-facing interface directly
# (src.interfaces.web_interface) rather than reimplementing the client
# protocol, so HuRI's `src` package must be importable. HuRI isn't a pip
# package, so main.py adds it to sys.path itself — HURI_REPO_PATH overrides
# the default sibling-checkout guess (../../HuRI relative to this repo root).
: "${HURI_REPO_PATH:=$(cd "$PROJECT_DIR/../HuRI" 2>/dev/null && pwd || true)}"
export HURI_REPO_PATH
if [ -z "$HURI_REPO_PATH" ]; then
  echo "Warning: could not find a sibling HuRI checkout; set HURI_REPO_PATH explicitly." >&2
fi

echo "Starting FastAPI backend on http://localhost:8000 (HURI_REPO_PATH=$HURI_REPO_PATH)"
uvicorn main:app --reload --host 0.0.0.0 --port 8001
