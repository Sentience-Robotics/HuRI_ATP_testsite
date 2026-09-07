# HuRI website backend — OIDC relying party + browser<->HuRI websocket bridge.
# Build context is this directory (HuRI_website_demo/backend).
#
#   docker build -t <region>-docker.pkg.dev/<project>/<repo>/huri-website:latest .
#   docker push  <region>-docker.pkg.dev/<project>/<repo>/huri-website:latest
#
# TODO(deploy): main.py now imports HuRI's own `src.interfaces.web_interface`
# (see scripts/run_backend.sh) instead of a bespoke client, so this image also
# needs HuRI's `src/` tree on PYTHONPATH/HURI_REPO_PATH at runtime — e.g. build
# with a context that includes both repos and COPY HuRI/src in, or vendor it
# as a git submodule. Not wired up here yet; local dev via run_backend.sh
# (sibling checkout, same machine) is unaffected.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # get_or_create_user_id() writes a fallback UUID here only when REQUIRE_AUTH
    # is off; keep it on a writable path for the non-root user.
    HURI_USER_ID_FILE=/tmp/.huri_user_id

# libsndfile backs soundfile/librosa at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run unprivileged.
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
