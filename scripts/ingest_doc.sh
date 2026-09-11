#!/usr/bin/env bash
set -euo pipefail

# Publish one or more Markdown files into the `documents` collection of the
# Qdrant this site is currently linked to, using HuRI's own ingestion CLI
# (HuRI/src/modules/rag/ingestion.py). The file is chunked as plain text —
# headings, lists and code fences go in verbatim, which is what you want:
# they give the retrieved chunks their context.
#
#   ./scripts/ingest_doc.sh notes.md
#   ./scripts/ingest_doc.sh --replace notes.md        # re-publish: drop the old chunks first
#   ./scripts/ingest_doc.sh --user-id <uuid> notes.md # one device's partition only
#   ./scripts/ingest_doc.sh --list                    # what's published (for that user id)
#   ./scripts/ingest_doc.sh --share-from <uuid>       # move docs stuck under one id to __shared__
#
# "Currently linked" means: whatever HuRI/scripts/install_local.sh wired this
# machine to. The installer records the Qdrant URL, the embedding endpoint +
# model and the SSL policy in <HuRI checkout>/.huri-local/plan.env, and the
# generated Serve config (config/huri_local.generated.yaml) is rendered from
# the same values — so reading plan.env guarantees documents get embedded by
# the SAME model the running RAGHandle queries with. Mixing models (even ones
# of the same dimension) silently returns garbage at retrieval time, which is
# why this script refuses to fall back to ingestion.py's local
# SentenceTransformer default when no embedding endpoint is configured.
#
# Which checkout is "the" HuRI is resolved like run_backend.sh does
# (HURI_REPO_PATH, else the HuRI/ submodule, else a sibling ../HuRI), then —
# because the submodule may be a bare checkout with no venv/.huri-local while
# the actual install lives in a sibling directory — any sibling checkout
# carrying a .huri-local/plan.env is accepted as the installed one, as long
# as there's exactly one. Set HURI_REPO_PATH to disambiguate. Every value can
# also be overridden individually: HURI_QDRANT_URL, HURI_EMBED_URL,
# HURI_EMBED_MODEL, HURI_VERIFY_SSL (true/false), HURI_PYTHON.
#
# User id: retrieval only returns chunks whose `_user_id` is the querying
# user's own OR the reserved shared id `__shared__` (see rag.py `_search`).
# In this site's default open mode every browser gets its own UUID, so a doc
# ingested under any single id is invisible to every other device — hence
# the default here is `__shared__`, i.e. "published to everyone". Pass
# --user-id (or run with HURI_USER_ID set, the same variable that pins the
# backend to one partition) to target one partition instead.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SHARED_USER_ID="__shared__"   # must match SHARED_USER_ID in HuRI/src/modules/rag/rag.py

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] FILE.md [FILE2.md ...]
       $(basename "$0") [options] --list
       $(basename "$0") [options] --share-from OLD_ID [--dry-run]

Publish Markdown files into the linked Qdrant's document collection.

Options:
  --user-id ID       Partition to publish into (default: \$HURI_USER_ID, else "$SHARED_USER_ID"
                     = visible to every user/device).
  --collection NAME  Qdrant collection (default: documents).
  --replace          Delete chunks previously ingested from a file of the same name (same
                     user id) before ingesting, so re-publishing doesn't pile up duplicates.
  --chunk-size N     Target chunk size in words (ingestion.py default: 500).
  --overlap N        Overlap between chunks in words (ingestion.py default: 50).
  --list             Don't ingest; list what the collection holds for that user id.
  --share-from ID    Don't ingest; re-tag documents currently under user id ID to the target
                     user id (--user-id, default "$SHARED_USER_ID") — for docs ingested with the raw
                     CLI under ~/.huri_user_id that no browser session can see. Vectors are kept,
                     nothing is re-embedded (scripts/share_docs.py).
  --dry-run          With --share-from: only list what would move.
  -h, --help         This help.

Environment (all optional — read from <HuRI checkout>/.huri-local/plan.env otherwise):
  HURI_REPO_PATH   HuRI checkout to use (same rule as run_backend.sh).
  HURI_QDRANT_URL, HURI_EMBED_URL, HURI_EMBED_MODEL, HURI_VERIFY_SSL, HURI_PYTHON
EOF
}

USER_ID="${HURI_USER_ID:-$SHARED_USER_ID}"
COLLECTION="documents"
REPLACE=0
LIST=0
SHARE_FROM=""
DRY_RUN=0
CHUNK_SIZE=""
OVERLAP=""
FILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --user-id=*)     USER_ID="${1#--user-id=}"; shift ;;
    --user-id)       USER_ID="${2:?--user-id needs a value}"; shift 2 ;;
    --collection=*)  COLLECTION="${1#--collection=}"; shift ;;
    --collection)    COLLECTION="${2:?--collection needs a value}"; shift 2 ;;
    --chunk-size=*)  CHUNK_SIZE="${1#--chunk-size=}"; shift ;;
    --chunk-size)    CHUNK_SIZE="${2:?--chunk-size needs a value}"; shift 2 ;;
    --overlap=*)     OVERLAP="${1#--overlap=}"; shift ;;
    --overlap)       OVERLAP="${2:?--overlap needs a value}"; shift 2 ;;
    --replace)       REPLACE=1; shift ;;
    --list)          LIST=1; shift ;;
    --share-from=*)  SHARE_FROM="${1#--share-from=}"; shift ;;
    --share-from)    SHARE_FROM="${2:?--share-from needs a user id}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    --)              shift; FILES+=("$@"); break ;;
    -*)              echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)               FILES+=("$1"); shift ;;
  esac
done

if [ "$LIST" -eq 0 ] && [ -z "$SHARE_FROM" ] && [ ${#FILES[@]} -eq 0 ]; then
  echo "No input file given." >&2
  usage >&2
  exit 1
fi

# Resolve inputs before any cd: ingestion.py opens them relative to its cwd.
ABS_FILES=()
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "Not a file: $f" >&2
    exit 1
  fi
  case "${f,,}" in
    *.md|*.markdown|*.txt) ;;
    *) echo "Note: $f is not .md/.markdown/.txt — ingesting it as plain text anyway." >&2 ;;
  esac
  ABS_FILES+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
done

# --- 1. Which HuRI checkout: same precedence as run_backend.sh -----------------
if [ -n "${HURI_REPO_PATH:-}" ]; then
  HURI_REPO="$HURI_REPO_PATH"
elif [ -f "$PROJECT_DIR/HuRI/src/modules/rag/ingestion.py" ]; then
  HURI_REPO="$PROJECT_DIR/HuRI"
else
  HURI_REPO="$(cd "$PROJECT_DIR/../HuRI" 2>/dev/null && pwd || true)"
fi
if [ -z "$HURI_REPO" ] || [ ! -f "$HURI_REPO/src/modules/rag/ingestion.py" ]; then
  echo "Could not find HuRI's src/modules/rag/ingestion.py (looked in HURI_REPO_PATH, $PROJECT_DIR/HuRI, ../HuRI)." >&2
  echo "  Run 'git submodule update --init' or set HURI_REPO_PATH." >&2
  exit 1
fi

# --- 2. Which checkout is *installed* (has plan.env): that's the link -----------
PLAN_ENV=""
if [ -r "$HURI_REPO/.huri-local/plan.env" ]; then
  PLAN_ENV="$HURI_REPO/.huri-local/plan.env"
elif [ -z "${HURI_REPO_PATH:-}" ]; then
  # Explicit HURI_REPO_PATH means "this one, period" — only auto-discover when
  # we picked the checkout ourselves.
  candidates=()
  for p in "$PROJECT_DIR"/../*/.huri-local/plan.env; do
    [ -r "$p" ] || continue
    d="$(cd "$(dirname "$p")/.." && pwd)"
    [ -f "$d/src/modules/rag/ingestion.py" ] || continue
    candidates+=("$d")
  done
  if [ ${#candidates[@]} -eq 1 ]; then
    PLAN_ENV="${candidates[0]}/.huri-local/plan.env"
    echo "Using the installed HuRI checkout at ${candidates[0]} (has .huri-local/plan.env; $HURI_REPO doesn't)."
  elif [ ${#candidates[@]} -gt 1 ]; then
    echo "Several installed HuRI checkouts found next to this repo:" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    echo "Set HURI_REPO_PATH to the one this site is linked to." >&2
    exit 1
  fi
fi

# Explicit env wins over plan.env; plan.env is plain KEY=VALUE assignments and
# is sourced (not exported) the way the installer's own start.sh/status.sh do.
ovr_qdrant="${HURI_QDRANT_URL:-}"
ovr_embed_url="${HURI_EMBED_URL:-}"
ovr_embed_model="${HURI_EMBED_MODEL:-}"
ovr_verify="${HURI_VERIFY_SSL:-}"
ovr_python="${HURI_PYTHON:-}"
if [ -n "$PLAN_ENV" ]; then
  # shellcheck disable=SC1090
  . "$PLAN_ENV"
fi
HURI_QDRANT_URL="${ovr_qdrant:-${HURI_QDRANT_URL:-}}"
HURI_EMBED_URL="${ovr_embed_url:-${HURI_EMBED_URL:-}}"
HURI_EMBED_MODEL="${ovr_embed_model:-${HURI_EMBED_MODEL:-}}"
HURI_VERIFY_SSL="${ovr_verify:-${HURI_VERIFY_SSL:-true}}"
HURI_PYTHON="${ovr_python:-${HURI_PYTHON:-}}"

missing=()
[ -n "$HURI_QDRANT_URL" ] || missing+=(HURI_QDRANT_URL)
[ -n "$HURI_EMBED_URL" ]  || missing+=(HURI_EMBED_URL)
[ -n "$HURI_EMBED_MODEL" ] || missing+=(HURI_EMBED_MODEL)
if [ ${#missing[@]} -gt 0 ]; then
  if [ -z "$PLAN_ENV" ]; then
    echo "No .huri-local/plan.env found under $HURI_REPO (HuRI isn't installed there), and no overrides given." >&2
    echo "  Either run HuRI/scripts/install_local.sh, set HURI_REPO_PATH to the installed checkout," >&2
    echo "  or export ${missing[*]} yourself." >&2
  else
    echo "$PLAN_ENV doesn't define ${missing[*]} — re-run install_local.sh --only config, or export them." >&2
  fi
  exit 1
fi

# --- 3. Python with HuRI's deps (qdrant-client, httpx, numpy) -------------------
INSTALLED_REPO="$HURI_REPO"
[ -n "$PLAN_ENV" ] && INSTALLED_REPO="$(cd "$(dirname "$PLAN_ENV")/.." && pwd)"
if [ -z "$HURI_PYTHON" ] || [ ! -x "$HURI_PYTHON" ]; then
  if [ -x "$INSTALLED_REPO/.venv/bin/python" ]; then
    HURI_PYTHON="$INSTALLED_REPO/.venv/bin/python"
  else
    HURI_PYTHON="$(command -v python3 || true)"
  fi
fi
if [ -z "$HURI_PYTHON" ] || ! "$HURI_PYTHON" -c 'import qdrant_client, httpx, numpy' 2>/dev/null; then
  echo "${HURI_PYTHON:-python3} can't import qdrant_client/httpx/numpy." >&2
  echo "  Point HURI_PYTHON at HuRI's venv python (install_local.sh creates <checkout>/.venv)." >&2
  exit 1
fi

# --- 4. Preflight the link so a dead Qdrant is one line, not a traceback ------
CURL_K=()
[ "$HURI_VERIFY_SSL" = "false" ] && CURL_K=(-k)
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 5 "${CURL_K[@]}" "${HURI_QDRANT_URL%/}/readyz" >/dev/null 2>&1; then
    echo "Qdrant at $HURI_QDRANT_URL is not answering /readyz (verify_ssl=$HURI_VERIFY_SSL)." >&2
    echo "  Check the endpoint, or override with HURI_QDRANT_URL / HURI_VERIFY_SSL." >&2
    exit 1
  fi
fi

# --- 5. Run ------------------------------------------------------------------
COMMON=(
  --user-id "$USER_ID"
  --collection "$COLLECTION"
  --qdrant-url "$HURI_QDRANT_URL"
  --embedding-url "$HURI_EMBED_URL"
  --embedding-model "$HURI_EMBED_MODEL"
  --chunking fixed   # semantic chunking needs a local SentenceTransformer; not an option over an endpoint
)
[ "$HURI_VERIFY_SSL" = "false" ] && COMMON+=(--no-verify-ssl)
[ -n "$CHUNK_SIZE" ] && COMMON+=(--chunk-size "$CHUNK_SIZE")
[ -n "$OVERLAP" ] && COMMON+=(--overlap "$OVERLAP")

echo "Qdrant:     $HURI_QDRANT_URL  (collection: $COLLECTION, verify_ssl: $HURI_VERIFY_SSL)"
echo "Embeddings: $HURI_EMBED_URL  (model: $HURI_EMBED_MODEL)"
echo "User id:    $USER_ID$([ "$USER_ID" = "$SHARED_USER_ID" ] && echo '  (shared: visible to every user/device)')"
echo "Tool:       $HURI_REPO/src/modules/rag/ingestion.py  via $HURI_PYTHON"
echo

# `-m src.modules.rag.ingestion` from the checkout root so its relative
# imports (.qdrant_utils) resolve; the cwd is always first on sys.path with -m,
# so a PYTHONPATH pointing at another checkout (a sourced env.sh) can't hijack it.
cd "$HURI_REPO"

if [ "$LIST" -eq 1 ]; then
  exec "$HURI_PYTHON" -m src.modules.rag.ingestion "${COMMON[@]}" list
fi

if [ -n "$SHARE_FROM" ]; then
  # share_docs.py imports src.modules.rag.qdrant_utils, hence PYTHONPATH.
  SHARE_ARGS=(--to "$USER_ID" --collection "$COLLECTION" --qdrant-url "$HURI_QDRANT_URL")
  [ "$HURI_VERIFY_SSL" = "false" ] || SHARE_ARGS+=(--verify-ssl)
  [ "$DRY_RUN" -eq 1 ] && SHARE_ARGS+=(--dry-run)
  exec env PYTHONPATH="$HURI_REPO${PYTHONPATH:+:$PYTHONPATH}" \
    "$HURI_PYTHON" "$SCRIPT_DIR/share_docs.py" "$SHARE_FROM" "${SHARE_ARGS[@]}"
fi

if [ "$REPLACE" -eq 1 ]; then
  # ingestion.py stores the file's basename as `source`; delete is scoped to
  # that source + this user id, so other users' copies are untouched.
  for f in "${ABS_FILES[@]}"; do
    "$HURI_PYTHON" -m src.modules.rag.ingestion "${COMMON[@]}" delete --source "$(basename "$f")"
  done
  echo
fi

exec "$HURI_PYTHON" -m src.modules.rag.ingestion "${COMMON[@]}" text "${ABS_FILES[@]}"
