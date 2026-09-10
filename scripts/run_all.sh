#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --host[=IP] — forwarded to both run_backend.sh and run_frontend.sh so a
# phone (or any other LAN device) can reach the site; see the comments in
# those two scripts for what each does with it. Resolved once here (rather
# than left to each child) so backend and frontend agree on the same
# address instead of each auto-detecting independently.
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

HOST_FLAGS=()
if [ -n "$HOST_ARG" ]; then
  if [ "$HOST_ARG" = "auto" ]; then
    HOST_ARG="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -z "$HOST_ARG" ]; then
      echo "Could not auto-detect a LAN IP; pass one explicitly: --host <ip>" >&2
      exit 1
    fi
  fi
  HOST_FLAGS=(--host "$HOST_ARG")
  # Set these here, before delegating, so run_backend.sh/run_frontend.sh's own
  # `${VAR:-...}` defaults don't independently re-derive (and potentially
  # disagree on) the LAN IP.
  export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://$HOST_ARG:8001}"
  export FRONTEND_URL="${FRONTEND_URL:-http://$HOST_ARG:5173}"
fi

# Local dev by default: no Authelia, no signed-in session required. Export
# REQUIRE_AUTH=1 yourself (plus OIDC_ISSUER/etc, see backend/main.py) to
# exercise the real login flow instead.
export REQUIRE_AUTH="${REQUIRE_AUTH:-0}"
export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:8001}"
BACKEND_URL="${VITE_BACKEND_URL}"

pids=()

cleanup() {
  echo
  echo "==> Shutting down..."
  # Ask the backend's launcher to stop HuRI cleanly (SIGINT to `serve run`,
  # then `ray stop`) before anything gets killed out from under it.
  curl -fsS -X POST "$BACKEND_URL/launcher/huri/stop" >/dev/null 2>&1 || true
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting backend on $BACKEND_URL ..."
"$SCRIPT_DIR/run_backend.sh" "${HOST_FLAGS[@]}" &
pids+=("$!")

echo "==> Waiting for the backend to come up..."
for _ in $(seq 1 60); do
  curl -fsS "$BACKEND_URL/presets" >/dev/null 2>&1 && break
  sleep 1
done

echo "==> Starting frontend..."
"$SCRIPT_DIR/run_frontend.sh" "${HOST_FLAGS[@]}" &
pids+=("$!")

echo
if [ ${#HOST_FLAGS[@]} -gt 0 ]; then
  echo "Backend and frontend are up. HuRI itself is NOT started — open"
  echo "http://$HOST_ARG:5173 (e.g. from your phone) and use the HuRI"
  echo "Control Panel (it opens automatically) to pick a config and start"
  echo "it. Ctrl-C here stops everything cleanly, including HuRI if you"
  echo "started it."
else
  echo "Backend and frontend are up. HuRI itself is NOT started — open"
  echo "http://localhost:5173 and use the HuRI Control Panel (it opens"
  echo "automatically) to pick a config and start it. Ctrl-C here stops"
  echo "everything cleanly, including HuRI if you started it."
fi
wait
