#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --host[=IP] — `npm run dev` already runs `vite --host` (see
# frontend/package.json), which binds 0.0.0.0 and is reachable from your LAN
# regardless. What --host actually fixes is HTTPS + same-origin backend
# access: phone browsers require a secure context for
# navigator.mediaDevices.getUserMedia (mic button), which plain HTTP over a
# LAN IP never gets — desktop-only exempts localhost. So --host generates a
# self-signed cert (see ensure_dev_cert.sh) and serves Vite over HTTPS; the
# backend is reached through Vite's own proxy (see vite.config.js) rather
# than a separate http://<lan-ip>:8001 origin, since mixing HTTPS+HTTP would
# just trade the mic bug for a mixed-content block. Bare --host auto-detects
# this machine's LAN IP via `hostname -I`.
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
  "$SCRIPT_DIR/ensure_dev_cert.sh" "$HOST_ARG"
  export VITE_DEV_HTTPS=1
  # A cross-origin VITE_BACKEND_URL (e.g. exported by an old shell session
  # before the same-origin proxy existed, or left over from a plain
  # `export VITE_BACKEND_URL=...`) would make the frontend fetch/websocket
  # straight to http://<lan-ip>:8001 instead of through the HTTPS proxy —
  # silently reintroducing the mixed-content block this --host mode exists to
  # avoid (surfaces as "asks to sign in again" once /auth/me's fetch throws
  # and the frontend's catch-all assumes auth is required). LAN mode always
  # owns BACKEND_URL, so unset any inherited value here.
  if [ -n "${VITE_BACKEND_URL:-}" ]; then
    echo "LAN mode: ignoring inherited VITE_BACKEND_URL=$VITE_BACKEND_URL (using same-origin proxy instead)"
    unset VITE_BACKEND_URL
  fi
  LAN_MODE=1
  echo "LAN mode: serving https://$HOST_ARG:5173 (backend proxied same-origin, run_backend.sh on the same machine)"
fi

cd "$PROJECT_DIR/frontend"

if [ ! -d node_modules ]; then
  echo "Installing frontend dependencies..."
  npm install
fi

if [ "${LAN_MODE:-0}" = "1" ]; then
  echo "Starting Vite dev server on https://$HOST_ARG:5173"
else
  # config.js falls back to http://localhost:8000 when unset (matching a
  # same-origin deploy's port), but run_backend.sh actually serves on 8001 in
  # local dev — HuRI itself owns 8000. Default the override here so a plain
  # run of this script just works; still respect an explicit override.
  export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:8001}"
  echo "Starting Vite dev server on http://localhost:5173 (VITE_BACKEND_URL=$VITE_BACKEND_URL)"
fi
npm run dev
