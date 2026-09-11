import useStore from "../store/index.js";

/**
 * One line above the composer saying what the microphone is doing, and what
 * HuRI's STT is hearing (HuRI's "transcript" hook: sliding-window partials
 * while you talk, then the whole-utterance final — which closing the mic
 * forces, see store.stopListening).
 *
 * This is the first place to look when voice input "does nothing": a red mic
 * button with flat level bars was previously the same picture for "listening
 * to silence", "muted while the avatar speaks", "gate stuck", "disconnected"
 * and "the OS took the mic away".
 */
export default function MicStatusLine() {
  const recording = useStore((s) => s.recording);
  const connectionStatus = useStore((s) => s.connectionStatus);
  const micGated = useStore((s) => s.micGated);
  const micNotice = useStore((s) => s.micNotice);
  const liveTranscript = useStore((s) => s.liveTranscript);
  const lastFinalTranscript = useStore((s) => s.lastFinalTranscript);
  const finishing = useStore((s) => s.finishing);
  const hasStt = useStore((s) => s.hasModule("stt"));

  let tone = "muted";
  let text;
  if (micNotice) {
    tone = "warn";
    text = micNotice;
  } else if (!recording) {
    // Closing the mic ends the utterance (store.stopListening): the last
    // partial stays up until HuRI's final replaces it. A partial still here
    // once `finishing` is over means that final never came — the sentence
    // was lost server-side, so keep what was heard rather than "Mic off".
    if (finishing && liveTranscript) {
      tone = "live";
      text = `Finishing — “${liveTranscript}”`;
    } else if (liveTranscript) {
      tone = "warn";
      text = `No final transcript from HuRI — last heard “${liveTranscript}”`;
    } else {
      text = lastFinalTranscript ? `Heard — “${lastFinalTranscript}”` : "Mic off";
    }
  } else if (connectionStatus !== "connected") {
    tone = "warn";
    text = "Mic on, but disconnected — audio is not being sent";
  } else if (micGated) {
    text = "Muted while the avatar speaks";
  } else if (liveTranscript) {
    tone = "live";
    text = `Listening — “${liveTranscript}”`;
  } else if (lastFinalTranscript) {
    tone = "live";
    text = `Listening… (heard: “${lastFinalTranscript}”)`;
  } else {
    tone = "live";
    text = hasStt ? "Listening…" : "Streaming audio (no stt module in this session)";
  }

  return (
    <div className={`mic-status ${tone}`} aria-live="polite">
      {text}
    </div>
  );
}
