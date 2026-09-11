import { useMemo, useState } from "react";
import useStore from "../store/index.js";
import { ensureContext, getRemaining } from "../audio/playback.js";
import { startMic, stopMic } from "../audio/microphone.js";
import MicStatusLine from "./MicStatusLine.jsx";

const TOPIC_LABELS = {
  "audio.in": "audio.in",
  question: "rag.in",
  token: "rag.out",
};

function micLevelFromFrame(buf) {
  const int16 = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < int16.length; i++) sum += Math.abs(int16[i]);
  return Math.min(1, sum / int16.length / 8000);
}

export default function Composer({ onOpenSettings }) {
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("question");
  const [level, setLevel] = useState(0);

  const hasModule = useStore((s) => s.hasModule);
  const sendTopic = useStore((s) => s.sendTopic);
  const pushMicFrame = useStore((s) => s.pushMicFrame);
  const submitText = useStore((s) => s.submitText);
  const beginListening = useStore((s) => s.beginListening);
  const stopListening = useStore((s) => s.stopListening);
  const setStatusMessage = useStore((s) => s.setStatusMessage);
  const setMicGated = useStore((s) => s.setMicGated);
  const setMicNotice = useStore((s) => s.setMicNotice);
  const recording = useStore((s) => s.recording);
  const connected = useStore((s) => s.connectionStatus === "connected");

  const canAudio = hasModule("mic");
  const canQuestion = hasModule("rag");
  const canToken = hasModule("tts");

  const options = useMemo(() => {
    const opts = [];
    if (canAudio) opts.push("audio.in");
    if (canQuestion) opts.push("question");
    if (canToken) opts.push("token");
    return opts;
  }, [canAudio, canQuestion, canToken]);

  const activeTopic = options.includes(topic) ? topic : options[0];
  const isAudioTopic = activeTopic === "audio.in";

  const submit = () => {
    if (isAudioTopic || !text.trim() || !connected) return;
    // Open/unlock the output context here, inside the send gesture. TTS chunks
    // are scheduled from a WebSocket callback, and a context first created
    // there has no user activation behind it — it starts suspended and
    // resume() is a no-op, so the reply plays into silence. Typing is the only
    // gesture a text-only session ever produces (the mic path does the same in
    // toggleMic).
    ensureContext();
    submitText(activeTopic, text);
    setText("");
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const toggleMic = async () => {
    if (recording) {
      // Capture first, then the store: stopListening() sends HuRI the
      // mic-closed marker that ends the sentence, and it has to land after
      // the last audio frame (see store.stopListening).
      stopMic();
      stopListening();
      setLevel(0);
      return;
    }
    ensureContext();
    beginListening();
    const onFrame = (buf) => {
      // Half-duplex: never stream the avatar's own voice back into HuRI's
      // VAD — it reads as the user still talking, so the turn never ends.
      // `assistantSpeaking` covers the reply from the moment it starts;
      // getRemaining() covers its tail, since TTS chunks are scheduled ahead
      // on the pts clock and the "audio" end marker lands well before the
      // sound actually stops (see audio/playback.js). Both have a way out
      // (a watchdog in the store, a suspended-context check in playback.js)
      // so this gate can no longer hold the mic shut for good.
      const gated = useStore.getState().assistantSpeaking || getRemaining() > 0;
      setMicGated(gated);
      if (gated) {
        setLevel(0);
        return;
      }
      setLevel(micLevelFromFrame(buf));
      pushMicFrame(buf);
      // Silently a no-op while disconnected — MicStatusLine says so.
      useStore.getState().sendAudioFrame?.(buf);
    };
    // The capture can stop underneath us on a phone (another app takes the
    // mic, a call, screen lock). Say so instead of leaving a red button that
    // streams nothing.
    const onState = (state) => {
      if (state === "ended") {
        stopMic();
        stopListening();
        setLevel(0);
        setMicNotice("Microphone was released by the system — tap 🎤 to resume.");
      } else if (state === "muted") {
        setMicNotice("Microphone paused by the system (call or another app?) — waiting…");
      } else if (state === "unmuted") {
        setMicNotice("");
      } else if (state === "suspended") {
        setMicNotice("Audio suspended by the system — bring the page back to the front.");
      }
    };
    try {
      await startMic(onFrame, { onState });
    } catch (err) {
      console.error("Microphone error", err);
      stopMic();
      stopListening();
      setStatusMessage("Microphone unavailable — check browser permissions.");
    }
  };

  // Layout hooks for theme.css: on narrow screens the composer becomes a
  // two-row grid (text + mic + send on top, topic picker + level + settings
  // below) so the prompt gets the width; the modifier classes tell the grid
  // which of the optional controls exist so it doesn't reserve empty columns.
  const composerClass = [
    "composer",
    canAudio ? "" : "no-mic",
    options.length > 0 ? "" : "no-topic",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {canAudio && <MicStatusLine />}
      <div className={composerClass}>
        {options.length > 0 && (
          <select
            className="composer-select"
            value={activeTopic}
            onChange={(e) => setTopic(e.target.value)}
            title="Which HuRI topic a typed message is published on (rag.in = through RAG, rag.out = straight to TTS/gesture)"
            aria-label="Target topic"
          >
            {options.map((t) => (
              <option key={t} value={t}>
                {TOPIC_LABELS[t]}
              </option>
            ))}
          </select>
        )}

        <input
          type="text"
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isAudioTopic || !connected}
          placeholder={
            isAudioTopic
              ? "Use the mic to speak…"
              : connected
                ? "Enter your text"
                : "Connecting to HuRI…"
          }
        />

        {canAudio && (
          <div className="composer-mic-level" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                style={{
                  height: `${recording ? 4 + level * 16 * (1 - Math.abs(i - 2) / 3) : 4}px`,
                }}
              />
            ))}
          </div>
        )}

        {canAudio && (
          <button
            type="button"
            className={`icon-button mic-button ${recording ? "recording" : ""}`}
            onClick={toggleMic}
            title={recording ? "Stop recording (ends the sentence)" : "Record (audio.in)"}
          >
            {recording ? "⏹" : "🎤"}
          </button>
        )}

        <button
          type="button"
          className="icon-button settings-button"
          onClick={onOpenSettings}
          title="Event Configuration"
        >
          ⚙
        </button>

        <button
          type="button"
          className="icon-button send-button"
          onClick={submit}
          disabled={isAudioTopic || !text.trim() || !connected}
          title="Send"
        >
          ➤
        </button>
      </div>
    </>
  );
}
