# HuRI ATP test website

A browser-based testing console for [HuRI](https://github.com/Sentience-Robotics/HuRI) — lets a
tester pick any module combination (voice in, RAG, TTS, gesture, emotion...), launch HuRI itself
with a chosen deployment config, and drive a live session from a chat-style UI instead of a
terminal. Built to exercise every row of the ATP, the test plan this whole site is designed
around.

## Prerequisites

Before anything else:

- **Python 3.12.** Both HuRI's installer and this site's backend build their own venv from it.
  (HuRI's installer accepts 3.10–3.12 and this backend needs 3.11+; 3.12 is the one version
  that satisfies both, so that is what we require.)
- **Git LFS**, installed *before* cloning (`git lfs install`). The avatar's 3D model
  (`model.fbx`, in `backend/static/` and `frontend/public/`) is stored in LFS — without it you
  get a small text pointer file instead of the model and the avatar never renders. Already
  cloned without it? `git lfs install && git lfs pull`.
- **An NVIDIA GPU is needed for the GPU-heavy modules, TTS and gesture** — and even then only
  if enough VRAM is free (roughly 4.5 GiB for TTS + 2.2 GiB for gesture, on top of anything
  else on the card). HuRI's installer plans per module: without that headroom, or on AMD/CPU
  machines, it simply drops `tts` and `gesture` and you get the text and voice-in pipeline
  only. Presets that need them are greyed out in the Event Configuration modal; that is
  expected, not a bug. `HuRI/scripts/install_local.sh --plan-only` shows what your machine
  will run; see [FULL_INSTALLATION.md](FULL_INSTALLATION.md) for the numbers.

Then:

1. **The HuRI submodule checked out.** HuRI is vendored at `HuRI/` as a git submodule, not a
   plain folder — if it's empty, run:
   ```bash
   git submodule update --init
   ```

2. **HuRI itself, installed** — venv, downloaded models, and a generated Ray Serve config. Run
   HuRI's own installer *inside the submodule*:
   ```bash
   cd HuRI
   ./scripts/install_local.sh --yes
   ```
   This also sets up the two things HuRI needs at runtime:
   - **Qdrant** (RAG's vector memory) — started as a local Docker container (`huri-qdrant`) on
     `localhost:6333`, unless you pass `--skip-services` because one is already running (e.g.
     from another HuRI checkout on the same machine — Qdrant/Ollama are shared, machine-wide
     services, not per-checkout).
   - **Ollama** (LLM + embeddings) — installed and pulled with whatever models the capability
     plan picks (e.g. `mistral:7b`, `bge-m3`), reachable at `localhost:11434`.

   If you already have a working HuRI checkout elsewhere with Qdrant/Ollama already running,
   you can skip re-provisioning those two: `./scripts/install_local.sh --yes --skip-services`.
   See `HuRI/scripts/install_local.sh --help` for GPU/CPU profile flags.

3. **Node.js** (for the frontend). This site's own backend uses the Python 3.12 from above,
   in a venv separate from HuRI's (see below).

## Running it

The one-shot way:

```bash
./scripts/run_all.sh
```

This starts the backend (`:8001`) and frontend (`:5173`) and waits on both — Ctrl-C stops them
cleanly (including HuRI itself, if you started it from the Control Panel in the meantime). It
does **not** start HuRI automatically: open `http://localhost:5173`, use the **HuRI Control
Panel** button in the top bar, pick a config from the dropdown, and hit Start. That's deliberate —
see "Configuring HuRI" below for why launching HuRI is a UI action rather than baked into the
script.

To run the pieces separately (e.g. while iterating on just one of them):

```bash
./scripts/run_backend.sh    # FastAPI on :8001, auto-creates backend/.venv
./scripts/run_frontend.sh   # Vite dev server on :5173, auto-runs npm install
```

Both scripts auto-detect the HuRI checkout (the submodule at `HuRI/`, falling back to a sibling
`../HuRI` checkout for anyone still working that way) and point the HuRI Control Panel's
`serve`/`ray` binaries at that checkout's own venv. Override with `HURI_REPO_PATH` if yours lives
somewhere else.

By default `REQUIRE_AUTH=0` (`run_all.sh` sets this) — no Authelia needed. Each device/browser
that reaches the site gets its own HuRI `user_id` (a UUID issued on first visit and kept in a
cookie), so with `--host` your phone and your laptop each have their own RAG memory, and it
survives a backend restart. The id is shown in the top bar (👤 pill — hover for the full value,
click to copy) and logged by the backend on every connection. See **Auth** below to turn on the
real login flow, and **RAG identity** for how the id is resolved.

The site also remembers, per device, the last module combination you applied and the chat
transcript, so refreshing the page (or reopening it on the phone) comes back where you were
instead of re-handshaking with the rag-only default and showing the greeting again. **Clear
chat** in the top bar wipes the transcript. Note that HuRI's *short-term* context (RAG's
per-connection history) does restart on a reload — a divider in the chat marks the boundary;
only what HuRI saved to long-term memory when the previous session ended carries over.

## Configuring HuRI (the Control Panel)

HuRI itself is launched and stopped from inside the website, not from a terminal — that's
`backend/huri_launcher.py` spawning/supervising a `serve run <config>.yaml` subprocess on the
machine running the backend, and the **HuRI Control Panel** (top bar button) is its UI: pick a
config, watch it come up, tail its logs, jump to the Ray dashboard, and open a pre-configured
client tab.

The config dropdown lists two kinds of files:
- the bare `HuRI/config/huri*.yaml` files (e.g. `huri.yaml`, `huri_cpu.yaml`, and whatever
  `install_local.sh` generated as `huri_local.generated.yaml`), and
- per-ATP-feature copies under this repo's own `presets/F*/huri*.yaml` — see `presets/README.md`
  for which folder copies which config and why.

Only one HuRI instance can run at a time (it binds fixed local ports), so Start is disabled while
one is already up.

## Testing a session

Once HuRI is running, the app's default connection uses a minimal `rag`-only handshake so it
comes up immediately. From there:

- **Event Configuration** (gear icon) — pick a named preset or a custom module combination for
  the session. Modules HuRI hasn't actually deployed (e.g. `tts`/`gesture` on a machine with no
  GPU) are greyed out and can't be selected — checked live against `GET /huri-modules`, which
  proxies HuRI's own `/modules` endpoint.
- **Composer** — type text or use the mic; the event dropdown picks which topic a typed message
  targets (`rag.in` through the full pipeline, or `rag.out` straight at TTS/gesture, bypassing
  RAG — see the ATP's F7-F9 rows).
- **Chat panel** — each message can be expanded to show its linked emotion reading and the
  RAG-augmented prompt that was actually sent to the LLM.
- **Avatar** — only rendered when the active session includes the `gesture` module.

`presets/` holds the module-combination JSON files behind the Event Configuration dropdown,
organized to mirror the ATP's feature rows one-to-one (`F2/` through `F11/`) — see
`presets/README.md` for the full convention, including how to add a new preset (drop a `.json`
file in, no restart needed).

## Auth

Three modes, picked by what's set in the backend's environment (see `backend/main.py`):

| Mode | Set | Behaviour |
|---|---|---|
| Open (local dev) | `REQUIRE_AUTH=0` | No login screen; each device/browser gets its own `user_id` — a UUID issued on first visit and carried in the session cookie (see **RAG identity**). |
| Authelia (OIDC) | `REQUIRE_AUTH=1`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET` | Real login via `/auth/login`; the OIDC `sub` becomes the HuRI `user_id` (scopes RAG memory per user). |
| Magic link (demo) | `MAGIC_LINK_SECRET` | A signed token redeemed at `/auth/magic` drops the same session an OIDC login would, without running Authelia. The minting tool `main.py` refers to (`tools/make_magic_qr.py`) doesn't exist yet — see **Known gaps**. |

`SESSION_SECRET` is required whenever `REQUIRE_AUTH=1` — the backend refuses to start without one
rather than fall back to a public default, since it's what makes the session cookie unforgeable.

## RAG identity (what makes HuRI remember you)

HuRI scopes every RAG write and read to a `_user_id` (HuRI's `src/core/module.py`,
`src/modules/rag/*`), so the `user_id` the backend hands `run_browser_session` *is* what makes the
assistant remember someone across sessions. `resolve_user_id()` in `backend/main.py` picks it, in
order:

1. **the authenticated OIDC `sub`** — the real identity, one RAG partition per user;
2. **`HURI_USER_ID`** — an explicit override, to pin every session to a known partition (e.g. one
   you already ingested documents into);
3. **a per-device UUID** — minted by `GET /auth/me` on a browser's first visit (the first request
   the SPA makes on every page load) and carried in the signed session cookie from then on. This
   is what open mode (`REQUIRE_AUTH=0`) runs on: one partition per phone/laptop/browser. It lasts
   as long as the cookie does — a year of inactivity by default (`SESSION_MAX_AGE`), refreshed on
   every visit — so clearing site data, or using another browser on the same phone, means a fresh
   identity;
4. **a UUID generated once and persisted** to `HURI_USER_ID_FILE` (default `<repo root>/.huri_user_id`,
   written `0600`, gitignored) — the fallback for a websocket that arrives with no session cookie
   at all (a raw client that never called `/auth/me`).

`GET /auth/me` reports the resolved `user_id` and its `user_id_source` (`oidc` / `env` / `device` /
`shared`); the top bar's 👤 pill shows the same, and the backend logs
`Frontend connected (user_id=…, source=…)` per session — the quick way to tell "HuRI forgot me"
apart from "I'm talking to a different partition". Per-device ids are still not *authenticated*
(anyone holding the cookie is that device), so it's a dev/demo scheme, not multi-user — use
Authelia for that.

For a containerised deploy, point `HURI_USER_ID_FILE` at a mounted volume — otherwise the UUID is
regenerated on every image rebuild. To share one identity with HuRI's CLI client
(`src/client.py`), point it at HuRI's own `~/.config/huri/_user_id`. Note HuRI's RAG ingestion CLI
(`src/modules/rag/ingestion.py`) reads `~/.huri_user_id` instead, so line the two up — or pass
`--user-id` when ingesting — if documents you ingest should land in the partition this site reads.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HURI_REPO_PATH` | submodule at `HuRI/`, else sibling `../HuRI` | Where the backend imports `src.interfaces.web_interface` from, and where the Control Panel looks for `config/huri*.yaml` |
| `HURI_URL` | `ws://localhost:8000/session` | Where `web_interface.py`'s `Client` connects to reach a running HuRI |
| `HURI_SERVE_BIN` / `HURI_RAY_BIN` | plain `serve`/`ray` (PATH); `run_backend.sh` points these at `<HURI_REPO_PATH>/.venv/bin/{serve,ray}` when that venv exists | Binaries the Control Panel uses to launch/stop HuRI |
| `HURI_PRESETS_DIR` | `<repo root>/presets` | Where `/presets` and the Control Panel's config list are scanned from |
| `VITE_BACKEND_URL` | `http://localhost:8001` | Backend origin the frontend talks to (build-time env var) |
| `REQUIRE_AUTH` | `0` in `run_all.sh`, `1` otherwise | See **Auth** above |
| `HURI_USER_ID` | unset | Pins the HuRI `user_id` / RAG partition explicitly for every visitor; see **RAG identity** |
| `HURI_USER_ID_FILE` | `<repo root>/.huri_user_id` | Where the cookie-less fallback UUID is stored; see **RAG identity** |
| `SESSION_MAX_AGE` | 1 year (`REQUIRE_AUTH=0`), 14 days otherwise | Session-cookie lifetime, in seconds — in open mode that is how long a device keeps its `user_id` without visiting |

## Known gaps

- `backend/Dockerfile` isn't wired up for a real deployment yet — it doesn't include HuRI's
  `src/` tree or the repo-root `presets/` folder in its build context (see the `TODO(deploy)`
  comments at its top). Local dev via the scripts above is unaffected.
- The magic-link auth mode's redemption endpoint (`/auth/magic`) works, but the tool to mint a
  valid token (`tools/make_magic_qr.py`, referenced in `main.py`'s comments) hasn't been written
  yet — that mode isn't usable until it exists.
