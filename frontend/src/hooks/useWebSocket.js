import { useEffect, useRef, useState } from "react";
import useStore from "../store/index.js";
import { BACKEND_URL } from "../config.js";
import { saveSessionModules } from "../persist.js";

// Derive the websocket endpoint from the same backend origin the rest of the
// app uses (see config.js).
const WS_URL = BACKEND_URL.replace(/^http/, "ws") + "/ws";

// Reconnect backoff after an unintended close (HuRI restarted, the phone was
// locked long enough for the server's ping timeout, a flaky network). The
// server side is stateless per connection — a new socket is a fresh HuRI
// session with the same module handshake — so simply reopening is correct.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_MAX_TRIES = 10;

/** Decode a base64 string of little-endian float32 PCM into a Float32Array. */
function decodeAudio(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Owns the single websocket to the backend, speaking the protocol
 * HuRI/src/interfaces/web_interface.py + backend/main.py implement:
 *
 *   -> {"modules": {tag: {name, args}}}              handshake, once
 *   <- {"type": "session_config", "config": {...}}    resolved config echo
 *   -> {"topic": "question"|"token", "text": ...}     typed input (event picker)
 *   -> <binary ArrayBuffer>                            mic PCM frames
 *   -> <empty binary frame>                            mic closed (see store.stopListening)
 *   <- {"type": "token"|"audio"|"segment"|"question"|"transcript"|"error", ...}
 *
 * "question" already carries the linked emotion (RAGQuestion.emotion, the
 * aggregated per-utterance read) — that's the only source of emotion data on
 * the wire, there's no separate raw "emotion" stream to listen for.
 *
 * `initialModules` seeds the first handshake; calling the store's
 * `reconfigure(modules)` (wired up here) tears down the connection and opens
 * a fresh one with a new module combination — this is what the Event
 * Configuration modal's Apply button drives (HuRI/ATP.xlsx F1/F2). Every
 * combination applied this way is also remembered on this device (see
 * persist.js), which is where App.jsx gets `initialModules` from on the next
 * page load.
 *
 * `enabled` gates whether a connection is attempted at all: HuRI is started
 * on demand from the Control Panel (see App.jsx / LauncherPanel.jsx) rather
 * than automatically on page load, so this stays idle — no socket, no
 * "Connection error" noise — until the caller confirms HuRI is actually up.
 */
export function useWebSocket(initialModules, { enabled = true } = {}) {
  const [modules, setModules] = useState(initialModules);
  const wsRef = useRef(null);
  // Bumped to re-run the connection effect after an unintended close; the
  // failure count lives in a ref so resetting it on success doesn't itself
  // re-run the effect (which would tear down the connection just made).
  const [reconnectTick, setReconnectTick] = useState(0);
  const failuresRef = useRef(0);

  const {
    setConnectionStatus,
    setStatusMessage,
    setSessionConfig,
    setSendTopic,
    setSendAudioFrame,
    setSendAudioEnd,
    setReconfigure,
    onQuestion,
    onToken,
    onAudio,
    onMotionSegment,
    onTranscript,
  } = useStore.getState();

  useEffect(() => {
    setReconfigure((next) => {
      saveSessionModules(next);
      setModules(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) {
      setConnectionStatus("idle");
      setStatusMessage("Start HuRI from the Control Panel to connect.");
      setSessionConfig(null);
      return;
    }

    setConnectionStatus("connecting");
    setStatusMessage("Connecting to HuRI...");
    setSessionConfig(null);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    // Set by the cleanup below: a close we asked for (module change, HuRI
    // stopped, unmount) must not trigger a reconnect.
    let closing = false;
    let reconnectTimer = null;

    ws.onopen = () => {
      ws.send(JSON.stringify({ modules }));
      setSendTopic((topic, text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic, text }));
      });
      setSendAudioFrame((buf) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      });
      // End-of-speech marker: a zero-length audio frame, sent right behind
      // the last real one on the same socket so it can't overtake it. HuRI's
      // MIC reads an empty audio.in frame as "close the turn now"; a HuRI
      // checkout predating that just logs one "undecodable frame" warning and
      // ignores it, whereas a JSON message would have fallen through the old
      // bridge's default route as an empty typed *question*. Reports whether
      // it went out: the store only waits for the final transcript when it did.
      setSendAudioEnd(() => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(new ArrayBuffer(0));
        return true;
      });
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "session_config":
          failuresRef.current = 0;
          setSessionConfig(msg.config);
          setConnectionStatus("connected");
          setStatusMessage("Connected — type a message or use the mic.");
          break;
        case "transcript":
          onTranscript(msg);
          break;
        case "question":
          onQuestion(msg);
          break;
        case "token":
          onToken(msg);
          break;
        case "audio":
          // The wire field is snake_case (`sample_rate`, straight from HuRI's
          // WebAudioHook — backend/main.py passes "audio" messages through
          // untouched). Rename it here: scheduleChunk feeds it to
          // createBuffer(), which throws on a non-finite rate, and that
          // exception would take down this whole handler.
          onAudio({
            data: decodeAudio(msg.data),
            sampleRate: msg.sample_rate,
            pts: msg.pts,
            end: msg.end,
          });
          break;
        case "segment":
          // Gesture frames, already converted to this frontend's rig format
          // by the backend (main.py's _transform_outbound / pipeline.py).
          onMotionSegment(msg);
          break;
        case "error":
          // A remembered combination can stop being valid — e.g. HuRI was
          // relaunched with a config that no longer deploys tts/gesture — so
          // point at the way out rather than leave a bare error.
          setStatusMessage(
            `Error: ${msg.message} — pick another module combination in Event Configuration (⚙).`,
          );
          setConnectionStatus("error");
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      setStatusMessage("Connection error — is the backend running?");
      setConnectionStatus("error");
    };

    ws.onclose = (event) => {
      setSendTopic(null);
      setSendAudioFrame(null);
      setSendAudioEnd(null);
      // Whatever reply (or final transcript) we were waiting on is not coming
      // over this socket: never leave the mic gated, or the status line
      // "finishing", on a dead connection.
      useStore.getState()._releaseGate();
      useStore.getState()._stopFinishing();
      if (closing) {
        setConnectionStatus("closed");
        return;
      }
      const failures = ++failuresRef.current;
      if (failures > RECONNECT_MAX_TRIES) {
        setConnectionStatus("closed");
        setStatusMessage(
          "Disconnected — HuRI is not answering. Check the Control Panel, then re-apply the configuration (⚙).",
        );
        return;
      }
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (failures - 1));
      setConnectionStatus("connecting");
      setStatusMessage(
        `Disconnected (code ${event.code}) — reconnecting in ${Math.round(delay / 1000)}s (${failures}/${RECONNECT_MAX_TRIES})…`,
      );
      reconnectTimer = setTimeout(() => setReconnectTick((t) => t + 1), delay);
    };

    return () => {
      closing = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, enabled, reconnectTick]);
}
