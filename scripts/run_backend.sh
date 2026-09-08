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
# package, so main.py adds it to sys.path itself. Prefer the vendored git
# submodule at <repo root>/HuRI (see .gitmodules); fall back to the older
# sibling-checkout convention (../HuRI next to this repo) for anyone still
# working that way. HURI_REPO_PATH overrides both.
#
# Check for web_interface.py specifically, not just a `src/` dir: HuRI's own
# `main` branch doesn't have that module yet as of this writing (it's
# uncommitted work on a sibling checkout), so a bare `src/` dir can't tell a
# real checkout from an empty submodule.
if [ -z "${HURI_REPO_PATH:-}" ]; then
  if [ -f "$PROJECT_DIR/HuRI/src/interfaces/web_interface.py" ]; then
    HURI_REPO_PATH="$PROJECT_DIR/HuRI"
  else
    HURI_REPO_PATH="$(cd "$PROJECT_DIR/../HuRI" 2>/dev/null && pwd || true)"
  fi
fi
export HURI_REPO_PATH
if [ -z "$HURI_REPO_PATH" ]; then
  echo "Warning: could not find HuRI (submodule not checked out, no sibling checkout either);" >&2
  echo "  run 'git submodule update --init' or set HURI_REPO_PATH explicitly." >&2
fi

# The HuRI Control Panel (huri_launcher.py) spawns `serve run` itself, using
# whatever HURI_SERVE_BIN/HURI_RAY_BIN name — default "serve"/"ray" resolved
# via PATH, which this backend's own venv doesn't provide (it only needs
# FastAPI/httpx, not HuRI's full ML stack). Point them at the HuRI checkout's
# own venv instead of relying on PATH to have the right one on it.
if [ -n "$HURI_REPO_PATH" ] && [ -x "$HURI_REPO_PATH/.venv/bin/serve" ]; then
  export HURI_SERVE_BIN="${HURI_SERVE_BIN:-$HURI_REPO_PATH/.venv/bin/serve}"
  export HURI_RAY_BIN="${HURI_RAY_BIN:-$HURI_REPO_PATH/.venv/bin/ray}"
fi

echo "Starting FastAPI backend on http://localhost:8001 (HURI_REPO_PATH=$HURI_REPO_PATH)"
uvicorn main:app --reload --host 0.0.0.0 --port 8001
