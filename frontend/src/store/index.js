import { create } from "zustand";
import { resetUtterance, scheduleChunk } from "../audio/playback.js";
import { clearStoredMessages, loadMessages, saveMessages } from "../persist.js";

// The transcript this device kept from before the last page load (see
// persist.js) — seeds `messages` so a refresh resumes the conversation on
// screen instead of wiping it and re-showing the empty-state greeting.
const RESTORED_MESSAGES = loadMessages();

// Ids only need to be unique within this tab's transcript, restored entries
// included — so keep counting from past whatever was restored.
let nextId =
  1 + RESTORED_MESSAGES.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0);
const newId = () => `m${nextId++}`;

// How long a reply may go without any activity (token, audio chunk, end
// marker) before the half-duplex gate reopens the mic on its own. The gate is
// otherwise only released by a server "end" marker; if that never arrives
// (RAG/TTS failure, dropped frame, HuRI link died) the mic would stay shut for
// the rest of the session while the button still shows "recording".
const GATE_WATCHDOG_MS = 45_000;

// How long to wait, after closing the mic, for HuRI's final transcript of
// what was said (see `stopListening`). STT's whole-utterance pass gives up
// after 20 s and falls back to its partials (`final_timeout` in HuRI/src/
// modules/speech_to_text/speech_to_text.py), so nothing arriving by then
// means the pipeline or the link is gone — stop saying "finishing".
const FINISH_WATCHDOG_MS = 30_000;

/** Concatenate Int16 mic frames captured during a recording into one Float32
 * buffer, for attaching to the resulting user message (waveform + replay). */
function int16FramesToFloat32(frames) {
  const total = frames.reduce((n, f) => n + f.byteLength / 2, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    const int16 = new Int16Array(frame);
    for (let i = 0; i < int16.length; i++) out[offset++] = int16[i] / 0x8000;
  }
  return out;
}

/**
 * Chat + session state.
 *
 * One entry in `messages` per conversational turn (not per raw wire event):
 *   {id, role: "user"|"assistant", text, createdAt, completedAt, pending,
 *    emotion?: {label, confidence, scores}, audio?: {samples: Float32Array,
 *    sampleRate}, expanded}
 *
 * A turn's audio/motion arrive as a stream of chunks tagged with a shared
 * `pts` clock (see audio/playback.js); `frames` mirrors that for the avatar,
 * reset at the start of every new turn via `_resetTurn`.
 */
const useStore = create((set, get) => ({
  // --- connection / session -------------------------------------------
  connectionStatus: "idle", // "idle" | "connecting" | "connected" | "error" | "closed"
  statusMessage: "",
  sessionConfig: null, // {modules, senders, hooks}, echoed back by the backend
  sendTopic: null, // (topic, text) => void, installed by useWebSocket
  sendAudioFrame: null, // (ArrayBuffer) => void
  sendAudioEnd: null, // () => boolean — mic-closed marker; false if not connected
  reconfigure: null, // (modules) => void — re-handshakes with a new module set

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setSessionConfig: (sessionConfig) => {
    // A new session can't owe us a reply — never start one mic-gated, nor
    // waiting for a final transcript the old session was going to send.
    get()._releaseGate();
    get()._stopFinishing();
    set({ sessionConfig, _sentQuestions: [], liveTranscript: "", lastFinalTranscript: "" });
  },
  setSendTopic: (fn) => set({ sendTopic: fn }),
  setSendAudioFrame: (fn) => set({ sendAudioFrame: fn }),
  setSendAudioEnd: (fn) => set({ sendAudioEnd: fn }),
  setReconfigure: (fn) => set({ reconfigure: fn }),

  /** Whether a module is part of the currently active session — drives
   * conditional rendering (no mic button without "mic", no avatar panel
   * without "gesture", etc). */
  hasModule: (name) => {
    const modules = get().sessionConfig?.modules || {};
    return Object.values(modules).some((m) => m.name === name);
  },

  // --- avatar ------------------------------------------------------------
  frames: [],
  eyeHeight: null,
  setEyeHeight: (h) => set({ eyeHeight: h }),

  // --- mic -----------------------------------------------------------
  recording: false,
  _micBuffer: [], // Int16 ArrayBuffers captured during the current utterance

  /** Half-duplex gate: true from the moment a reply starts until it is done.
   *
   * HuRI's VAD closes a turn on silence (HuRI/src/modules/speech_to_text/
   * microphone_vad.py), so anything audible we keep streaming counts as the
   * user still talking — including the avatar's own voice coming back through
   * the speakers. Left ungated, the first reply retriggers the VAD, the turn
   * never ends, and the mic appears to stop working after one exchange.
   * Composer stops sending frames while this is set (and until the audio
   * already scheduled on the pts clock has actually finished playing). */
  assistantSpeaking: false,
  _gateTimer: null,

  /** Close the mic for a reply, with a watchdog (see GATE_WATCHDOG_MS). */
  _armGate: () => {
    const prev = get()._gateTimer;
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      if (!get().assistantSpeaking) return;
      console.warn(
        `assistantSpeaking watchdog: no reply activity for ${GATE_WATCHDOG_MS / 1000}s — reopening the mic`,
      );
      set({ assistantSpeaking: false, _gateTimer: null });
    }, GATE_WATCHDOG_MS);
    set({ assistantSpeaking: true, _gateTimer: timer });
  },
  /** Reply activity: push the watchdog back while it's still streaming. */
  _touchGate: () => {
    if (get().assistantSpeaking) get()._armGate();
  },
  _releaseGate: () => {
    const prev = get()._gateTimer;
    if (prev) clearTimeout(prev);
    if (get().assistantSpeaking || prev) set({ assistantSpeaking: false, _gateTimer: null });
  },

  /** What Composer decided for the latest mic frame: true while frames are
   * being dropped because a reply is (still) playing. Kept here so the UI can
   * show "muted" instead of a red button with flat level bars. */
  micGated: false,
  setMicGated: (micGated) => {
    if (get().micGated !== micGated) set({ micGated });
  },
  /** Something the OS did to the capture (track ended / muted), for display. */
  micNotice: "",
  setMicNotice: (micNotice) => set({ micNotice }),

  /** Live feedback from HuRI's STT ("transcript" hook): what it is hearing
   * right now (sliding-window partial, end=false) and the last whole-utterance
   * text it settled on (end=true). The final also arrives as the "question"
   * once QAG links its emotion — this is the debugging view, not the chat. */
  liveTranscript: "",
  lastFinalTranscript: "",
  onTranscript: ({ text, end }) => {
    if (end) {
      get()._stopFinishing();
      set({ lastFinalTranscript: text, liveTranscript: "" });
    } else {
      set({ liveTranscript: text });
    }
  },

  /** True from the mic being closed until HuRI's final transcript for what
   * was said lands (see `stopListening`). While set, `liveTranscript` is the
   * last partial of the utterance being finished; once the watchdog gives
   * up it stays on screen as the only record of what was heard. */
  finishing: false,
  _finishTimer: null,
  _stopFinishing: () => {
    const prev = get()._finishTimer;
    if (prev) clearTimeout(prev);
    if (get().finishing || prev) set({ finishing: false, _finishTimer: null });
  },

  pushMicFrame: (buf) => set((s) => ({ _micBuffer: [...s._micBuffer, buf] })),

  // --- turn lifecycle ------------------------------------------------
  /** Text questions this client published on "question" itself and therefore
   * expects to see come back on the "question" hook.
   *
   * HuRI fans a published event out to *every* subscriber of its topic, and
   * the web_question hook subscribes to the same "question" topic the text
   * sender publishes on (see HuRI/src/core/bus.py + web_interface.py). So a
   * typed message is echoed straight back to us alongside being handed to
   * RAG — without this, `onQuestion` would open a second turn for a message
   * `submitText` already rendered, duplicating the user bubble and leaving
   * the first assistant bubble pending forever. Entries are {id, text}, FIFO. */
  _sentQuestions: [],

  /** Reset the avatar/audio clock for a fresh turn. */
  _resetTurn: () => {
    resetUtterance();
    set({ frames: [] });
  },

  /** Typed input submitted from the Composer, targeting whichever topic the
   * event dropdown picked ("question" = rag.in, "token" = rag.out). */
  submitText: (topic, text) => {
    const trimmed = text.trim();
    if (!trimmed || !get().sendTopic) return;
    get()._resetTurn();
    const now = Date.now();
    const userId = newId();
    set((s) => ({
      _sentQuestions:
        topic === "question" && get().hasModule("qag")
          ? [...s._sentQuestions, { id: userId, text: trimmed }]
          : s._sentQuestions,
      messages: [
        ...s.messages,
        {
          id: userId,
          role: "user",
          text: trimmed,
          topic,
          createdAt: now,
          completedAt: now,
        },
        {
          id: newId(),
          role: "assistant",
          text: "",
          createdAt: now,
          completedAt: null,
          pending: true,
          audio: null,
        },
      ],
    }));
    get().sendTopic(topic, trimmed);
    if (get()._replyIsSpoken()) get()._armGate();
  },

  /** Whether this session actually produces a reply whose end we can wait for.
   * A transcription-only preset (mic+stt+tag+qag — ATP F5/F6) sends neither a
   * token nor an audio end marker, so gating the mic on it would hold the mic
   * shut forever. */
  _replyIsSpoken: () => get().hasModule("rag") || get().hasModule("tts"),

  /** Mic toggle (HuRI/ATP.xlsx F5/F6). */
  beginListening: () => {
    get()._resetTurn();
    get()._releaseGate();
    get()._stopFinishing();
    set({
      recording: true,
      _micBuffer: [],
      micGated: false,
      micNotice: "",
      liveTranscript: "",
      lastFinalTranscript: "",
    });
  },
  /** Mic closed: the utterance is over, whatever HuRI's VAD thinks.
   *
   * HuRI's MIC closes a turn after `silence_duration` of non-speech — and we
   * just stopped streaming, so that silence never reaches it. Left alone, the
   * turn stays open: no final transcript, no question, and the frames of the
   * next recording get glued onto this one as a continuation. So tell HuRI
   * explicitly (an empty audio.in frame, see useWebSocket's sendAudioEnd —
   * HuRI/src/modules/speech_to_text/microphone_vad.py `MIC.flush`): it
   * closes the turn at once and STT transcribes what was
   * said so far, falling back to its partials if the final pass fails. That
   * final transcript (and then the question) is what ends `finishing`; if it
   * never comes, the watchdog does. Must run AFTER the capture has stopped
   * (stopMic), so the marker really is the last thing on the socket. */
  stopListening: () => {
    get()._releaseGate();
    set({ recording: false, micGated: false });
    if (get().sendAudioEnd?.() !== true) {
      // Not connected: nothing was sent, so nothing is coming back.
      get()._stopFinishing();
      set({ liveTranscript: "" });
      return;
    }
    const prev = get()._finishTimer;
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      if (!get().finishing) return;
      console.warn(
        `no final transcript within ${FINISH_WATCHDOG_MS / 1000}s of closing the mic — giving up`,
      );
      set({ finishing: false, _finishTimer: null });
    }, FINISH_WATCHDOG_MS);
    set({ finishing: true, _finishTimer: timer });
  },

  /** "question" hook message: a voice utterance was fully transcribed and
   * (if the emotion modules are active) linked to its prosody read — closes
   * the user's turn and opens the assistant's (HuRI/ATP.xlsx F9/F10/F11). */
  onQuestion: ({ text, emotion }) => {
    // Our own typed question coming back (see `_sentQuestions`): the turn is
    // already on screen, so only fold in anything the echo adds — never a
    // second bubble pair, and no turn reset, since audio/frames for the reply
    // may already be streaming in.
    const echoed = get()._sentQuestions.find((q) => q.text === text);
    if (echoed) {
      set((s) => ({
        _sentQuestions: s._sentQuestions.filter((q) => q.id !== echoed.id),
        messages: emotion
          ? s.messages.map((m) => (m.id === echoed.id ? { ...m, emotion } : m))
          : s.messages,
      }));
      return;
    }

    const now = Date.now();
    const micBuffer = get()._micBuffer;
    get()._resetTurn();
    get()._stopFinishing();
    const audio = micBuffer.length
      ? { samples: int16FramesToFloat32(micBuffer), sampleRate: 16000 }
      : null;
    // Close the mic for the reply we just triggered (see `assistantSpeaking`).
    if (get()._replyIsSpoken()) get()._armGate();
    set((s) => ({
      _micBuffer: [],
      liveTranscript: "",
      messages: [
        ...s.messages,
        {
          id: newId(),
          role: "user",
          text,
          emotion: emotion || null,
          audio,
          createdAt: now,
          completedAt: now,
        },
        {
          id: newId(),
          role: "assistant",
          text: "",
          createdAt: now,
          completedAt: null,
          pending: true,
          audio: null,
        },
      ],
    }));
  },

  /** "token" hook message: streamed RAG answer text. */
  onToken: ({ text, end }) => {
    get()._touchGate();
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return {};
      messages[messages.length - 1] = { ...last, text: last.text + text };
      return { messages };
    });
    // No TTS in this session: the token stream is the whole reply, so its end
    // marker is what closes the turn (otherwise the "audio" end marker does).
    if (end && !get().hasModule("tts")) get()._completeLastAssistant();
  },

  /** "audio" hook message: one TTS chunk. */
  onAudio: ({ data, sampleRate, pts, end }) => {
    get()._touchGate();
    scheduleChunk(data, sampleRate, pts);
    if (data.length) {
      set((s) => {
        const messages = [...s.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return {};
        const prev = last.audio;
        const samples = prev
          ? concatFloat32(prev.samples, data)
          : Float32Array.from(data);
        messages[messages.length - 1] = { ...last, audio: { samples, sampleRate } };
        return { messages };
      });
    }
    if (end) get()._completeLastAssistant();
  },

  /** "segment" message: gesture frames, already converted to this frontend's
   * rig format by the backend (pipeline.py). */
  onMotionSegment: ({ frames }) => {
    if (!frames?.length) return;
    set((s) => ({ frames: [...s.frames, ...frames].sort((a, b) => a.t - b.t) }));
  },

  _completeLastAssistant: () => {
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant" || !last.pending) return {};
      messages[messages.length - 1] = {
        ...last,
        pending: false,
        completedAt: Date.now(),
      };
      return { messages };
    });
    // Reply finished: reopen the mic. Composer still holds it until the audio
    // already queued ahead on the pts clock has drained.
    get()._releaseGate();
  },

  // --- chat ------------------------------------------------------------
  messages: RESTORED_MESSAGES,
  /** How many leading `messages` came back from storage rather than from this
   * page load's session — ChatPanel draws the "restored" divider after them.
   * HuRI's own short-term history (RAG's per-connection `history`) did not
   * survive the reload, only what it saved to long-term memory on session
   * end, so it's worth making that boundary visible to a tester. */
  restoredCount: RESTORED_MESSAGES.length,
  toggleExpanded: (id) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, expanded: !m.expanded } : m,
      ),
    })),
  /** Wipe the transcript, on screen and in this device's storage. */
  clearMessages: () => {
    clearStoredMessages();
    set({ messages: [], restoredCount: 0, _sentQuestions: [] });
  },
}));

// Mirror the transcript into storage as it changes. Streaming replies touch
// `messages` once per token, so coalesce bursts — and flush on pagehide so a
// refresh mid-reply doesn't lose the tokens that arrived inside the window.
let persistTimer = null;
const flushMessages = () => {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  saveMessages(useStore.getState().messages);
};
useStore.subscribe((state, prev) => {
  if (state.messages === prev.messages) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushMessages, 250);
});
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushMessages);
}

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export default useStore;
