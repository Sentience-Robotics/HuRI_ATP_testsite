# HuRI ATP test website

A browser-based testing console for [HuRI](https://github.com/Sentience-Robotics/HuRI) — lets a
tester pick any module combination (voice in, RAG, TTS, gesture, emotion...), launch HuRI itself
with a chosen deployment config, and drive a live session from a chat-style UI instead of a
terminal. Built to exercise every row of the ATP, the test plan this whole site is designed
around.

## Prerequisites

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

3. **Node.js** (for the frontend) and **Python 3.11+** (for this site's own backend — separate
   from HuRI's venv, see below).

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

By default `REQUIRE_AUTH=0` (`run_all.sh` sets this) — no Authelia needed, every visitor is
treated as one open `anonymous` session. See **Auth** below to turn on the real login flow.

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
| Open (local dev) | `REQUIRE_AUTH=0` | No login screen; every session is `user_id=anonymous`. |
| Authelia (OIDC) | `REQUIRE_AUTH=1`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET` | Real login via `/auth/login`; the OIDC `sub` becomes the HuRI `user_id` (scopes RAG memory per user). |
| Magic link (demo) | `MAGIC_LINK_SECRET` | A signed token redeemed at `/auth/magic` drops the same session an OIDC login would, without running Authelia. The minting tool `main.py` refers to (`tools/make_magic_qr.py`) doesn't exist yet — see **Known gaps**. |

`SESSION_SECRET` is required whenever `REQUIRE_AUTH=1` — the backend refuses to start without one
rather than fall back to a public default, since it's what makes the session cookie unforgeable.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HURI_REPO_PATH` | submodule at `HuRI/`, else sibling `../HuRI` | Where the backend imports `src.interfaces.web_interface` from, and where the Control Panel looks for `config/huri*.yaml` |
| `HURI_URL` | `ws://localhost:8000/session` | Where `web_interface.py`'s `Client` connects to reach a running HuRI |
| `HURI_SERVE_BIN` / `HURI_RAY_BIN` | plain `serve`/`ray` (PATH); `run_backend.sh` points these at `<HURI_REPO_PATH>/.venv/bin/{serve,ray}` when that venv exists | Binaries the Control Panel uses to launch/stop HuRI |
| `HURI_PRESETS_DIR` | `<repo root>/presets` | Where `/presets` and the Control Panel's config list are scanned from |
| `VITE_BACKEND_URL` | `http://localhost:8001` | Backend origin the frontend talks to (build-time env var) |
| `REQUIRE_AUTH` | `0` in `run_all.sh`, `1` otherwise | See **Auth** above |

## Known gaps

- `backend/Dockerfile` isn't wired up for a real deployment yet — it doesn't include HuRI's
  `src/` tree or the repo-root `presets/` folder in its build context (see the `TODO(deploy)`
  comments at its top). Local dev via the scripts above is unaffected.
- The magic-link auth mode's redemption endpoint (`/auth/magic`) works, but the tool to mint a
  valid token (`tools/make_magic_qr.py`, referenced in `main.py`'s comments) hasn't been written
  yet — that mode isn't usable until it exists.
