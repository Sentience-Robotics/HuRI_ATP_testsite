"""Named module-combination presets for the Event Configuration modal.

Each preset is a ``{tag: {"name": <module>, "args": {...}}}`` block — exactly
the ``modules`` shape ``src.interfaces.web_interface.run_browser_session``
expects in its handshake (see HuRI/src/interfaces/web_interface.py). The
frontend lets a tester pick one of these as a starting point (or build a
custom combination) when configuring a session, covering HuRI/ATP.xlsx F1/F2
(different module combinations) without needing a server restart.

Mirrors HuRI/config/client_full.yaml and HuRI/config/client_text.yaml.
"""

from typing import Any, Dict

Preset = Dict[str, Dict[str, Any]]

# Full voice pipeline: mic -> stt -> tag -+
#                                          +-> qag -> rag -> tts -> gesture
#                       mic -> emo -> eag -+
FULL_VOICE: Preset = {
    "mic": {
        "name": "mic",
        "args": {
            "vad_agressiveness": 2,
            "silence_duration": 1.0,
            "block_duration": 0.03,
        },
    },
    "stt": {"name": "stt", "args": {"language": "en", "block_duration": 0.03}},
    "tag": {"name": "tag", "args": {}},
    "emo": {"name": "emo", "args": {"block_duration": 0.03}},
    "eag": {"name": "eag", "args": {}},
    "qag": {"name": "qag", "args": {}},
    "rag": {
        "name": "rag",
        "args": {
            "language": "en",
            "tone": "formal",
            "response_format": "paragraph",
            "max_length": 1024,
        },
    },
    "tts": {"name": "tts", "args": {}},
    "gesture": {"name": "gesture", "args": {}},
}

# Text-only: type a question ("rag.in"), get a streamed answer. No mic, no
# TTS/gesture — the fastest loop for testing RAG augmentation alone (F9).
TEXT_ONLY: Preset = {
    "rag": {
        "name": "rag",
        "args": {"language": "en", "tone": "formal", "response_format": "short"},
    }
}

# Speech + gesture only, no RAG: type text and pick the "token" event
# ("rag.out") to drive TTS/Gesture directly (F7/F8) without waiting on an LLM.
SPEECH_AND_GESTURE: Preset = {
    "tts": {"name": "tts", "args": {}},
    "gesture": {"name": "gesture", "args": {}},
}

NO_TTS_GESTURE: Preset = {
    "mic": {
        "name": "mic",
        "args": {
            "vad_agressiveness": 2,
            "silence_duration": 1.0,
            "block_duration": 0.03,
        },
    },
    "stt": {"name": "stt", "args": {"language": "en", "block_duration": 0.03}},
    "tag": {"name": "tag", "args": {}},
    "emo": {"name": "emo", "args": {"block_duration": 0.03}},
    "eag": {"name": "eag", "args": {}},
    "qag": {"name": "qag", "args": {}},
    "rag": {
        "name": "rag",
        "args": {
            "language": "en",
            "tone": "formal",
            "response_format": "paragraph",
            "max_length": 1024,
        },
    },
}


PRESETS: Dict[str, Preset] = {
    "full_voice": FULL_VOICE,
    "text_only": TEXT_ONLY,
    "no_tts_gesture": NO_TTS_GESTURE,
    "speech_and_gesture": SPEECH_AND_GESTURE,
}
