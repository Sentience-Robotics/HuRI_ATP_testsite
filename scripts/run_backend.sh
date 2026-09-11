#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --host[=IP] — mirrors `vite --host` in frontend/package.json: the backend
# already binds 0.0.0.0 below, so it's reachable from your LAN regardless.
# What --host actually fixes is CORS: allow_credentials=True means the
# CORSMiddleware can't wildcard origins, so FRONTEND_URL must exactly match
# wherever the SPA is actually loaded from (e.g. a phone hitting
# http://192.168.x.x:5173, not http://localhost:5173). Bare --host
# auto-detects this machine's LAN IP via `hostname -I`.
HOST_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host=*)
      HOST_ARG="${1#--host=}"
      shift
      ;;
    --host)
      if [ -n "${2:-}" ] && [[ "$2" != --* ]]; then
        HOST_ARG="$2"
        shift 2
      else
        HOST_ARG="auto"
        shift
      fi
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$HOST_ARG" ]; then
  if [ "$HOST_ARG" = "auto" ]; then
    HOST_ARG="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -z "$HOST_ARG" ]; then
      echo "Could not auto-detect a LAN IP; pass one explicitly: --host <ip>" >&2
      exit 1
    fi
  fi
  export FRONTEND_URL="${FRONTEND_URL:-http://$HOST_ARG:5173}"
  echo "LAN mode: allowing frontend origin $FRONTEND_URL (run_frontend.sh --host $HOST_ARG on the same machine)"
fi

# Local dev by default: no Authelia, no signed-in session required (same
# default as run_all.sh). Export REQUIRE_AUTH=1 yourself (plus OIDC_ISSUER/etc,
# see backend/main.py) to exercise the real login flow instead.
export REQUIRE_AUTH="${REQUIRE_AUTH:-0}"

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

# Which HuRI user_id (RAG memory partition) sessions will run as — see the
# "RAG identity" notes in main.py / README. In the default open mode every
# device gets its own id, so the concrete value only shows up once a browser
# connects: main.py logs "Frontend connected (user_id=..., source=...)" and
# the site's top bar shows it (👤 pill, click to copy).
if [ "$REQUIRE_AUTH" != "0" ]; then
  echo "RAG identity: each visitor's signed-in OIDC sub (REQUIRE_AUTH=$REQUIRE_AUTH)"
elif [ -n "${HURI_USER_ID:-}" ]; then
  echo "RAG identity: pinned to HURI_USER_ID=$HURI_USER_ID for every visitor"
else
  echo "RAG identity: one UUID per device/browser, issued on first visit (watch for"
  echo "  'Frontend connected (user_id=...)' below; the site's top bar shows it too)."
fi

echo "Starting FastAPI backend on http://localhost:8001 (HURI_REPO_PATH=$HURI_REPO_PATH)"
uvicorn main:app --reload --host 0.0.0.0 --port 8001
