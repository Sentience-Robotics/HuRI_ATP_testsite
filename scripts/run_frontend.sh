#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR/frontend"

if [ ! -d node_modules ]; then
  echo "Installing frontend dependencies..."
  npm install
fi

# config.js falls back to http://localhost:8000 when unset (matching a
# same-origin deploy's port), but run_backend.sh actually serves on 8001 in
# local dev — HuRI itself owns 8000. Default the override here so a plain
# run of this script just works; still respect an explicit override.
export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:8001}"

echo "Starting Vite dev server on http://localhost:5173 (VITE_BACKEND_URL=$VITE_BACKEND_URL)"
npm run dev
