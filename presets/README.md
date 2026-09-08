# Presets

Drop a `<name>.json` file here to add a module-combination preset to the
Event Configuration modal's dropdown — no server restart needed, the backend
recursively re-scans this folder (and every subfolder, any depth) on every
`GET /presets` request (see `backend/huri_presets.py`).

- The preset's key/label is its path relative to this folder, without the
  `.json` suffix, e.g. `rag_only.json` -> `rag_only`. Presets can be
  organized into subfolders for convenience — a file at
  `demo/no_gesture.json` becomes the key `demo/no_gesture`. Nesting is purely
  organizational; it carries no meaning to the backend or frontend beyond the
  resulting key.
- The file content is the `modules` block for that combination: a JSON object
  mapping each event tag to its module, in exactly the shape
  `src.interfaces.web_interface.run_browser_session` expects in its
  handshake:

  ```json
  {
    "tag": {
      "name": "module_name",
      "args": { "...": "..." }
    }
  }
  ```

- A malformed file (invalid JSON, or not an object) is skipped and logged as
  a warning by the backend rather than breaking the whole `/presets`
  response.

See `backend/huri_presets.py`'s existing files for real examples, and
`HuRI/config/client_full.yaml` / `HuRI/config/client_text.yaml` for the
module/args reference this shape mirrors.

## HuRI server configs (`huri*.yaml`)

A folder can also hold a *copy* of one of `HuRI/config/huri*.yaml` — the
server-side deployment config `serve run` launches HuRI with, as opposed to
the client `modules` presets above. `backend/huri_launcher.py` scans this
folder tree for `huri*.yaml` the same way `huri_presets.py` scans it for
`*.json`, and offers them in the HuRI Control Panel's launch dropdown keyed
by their path here (e.g. `F1/huri_cpu.yaml`), alongside the bare
`HuRI/config/huri*.yaml` files (keyed by plain filename). Same rule as the
client presets: these are copies for the tester's convenience, not the
source of truth — edit `HuRI/config/huri.yaml` itself for a real change, then
re-copy it into whichever `Fx/` folders reference it.

## `F*/` folders

`F1/` through `F11/` mirror HuRI/ATP.xlsx's feature rows one-to-one — each
holds a *copy* of whichever preset and/or HuRI config that feature's
Prerequisites column points at (see the sheet's `presets/Fx/...` paths), so a
tester can follow the spreadsheet straight to a real file without
cross-referencing which top-level file it happens to reuse. F1 and F3 hold
only a `huri*.yaml` (no client `modules` preset — neither feature involves a
client, they're pure HuRI-launch tests).

These are deliberate duplicates, not the source of truth — if you change a
module combination that's shared across features (e.g. `voice_with_speech`)
or a HuRI config (`huri.yaml`, `huri_cpu.yaml`), update every copy listed
below, or the dropdown/ATP will drift out of sync:

| Folder | Client preset copy of | HuRI config copy of | Used because |
|---|---|---|---|
| `F1/` | — | `huri.yaml`, `huri_cpu.yaml` | GPU vs CPU deployment settings to compare |
| `F2/` | `voice_with_speech.json`, `rag_only.json` | `huri.yaml` | two configs to compare (Configure modules) |
| `F3/` | — | `huri.yaml` | run-in-parallel check needs no client |
| `F4/` | `voice_with_speech.json` | `huri.yaml` | same config, launched twice (multi-client) |
| `F5/`, `F6/` | `voice_with_speech.json` | `huri.yaml` | needs mic + stt |
| `F7/`, `F8/` | `voice_with_avatar.json` | `huri.yaml` | needs tts / gesture |
| `F9/` | `rag_only.json` | `huri.yaml` | rag only, no voice needed |
| `F10/`, `F11/` | `voice_text_only.json` | `huri.yaml` | emotion/transcription checks, no tts/gesture output needed |

Naming: each name says what the preset *tests*, not just which modules it
contains — `rag_only` (text in, text out), `voice_with_speech` (the full
voice pipeline: mic through TTS/gesture), `voice_text_only` (voice in,
transcript + emotion out, no spoken reply — what "no_tts_gesture" used to be
called), `voice_with_avatar` (direct token -> speech/gesture, bypassing RAG).
