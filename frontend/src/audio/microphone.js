/**
 * Microphone capture.
 *
 * Streams the user's mic to a callback as fixed 30 ms frames of raw little-endian
 * int16 mono PCM @ 16 kHz — the exact payload HuRI's server-side `mic` (WebRTC
 * VAD) module expects. WebRTC VAD only accepts 10/20/30 ms frames at 8/16/48 kHz,
 * so the frame size is non-negotiable: 480 samples = 30 ms @ 16 kHz.
 *
 * This replaces the CLI client's `sounddevice` capture (HuRI/src/core/
 * client_senders.py::AudioSender) — the backend bridge can't and shouldn't touch
 * a microphone; the mic lives in the browser, the bridge only relays the bytes.
 *
 * Implementation note: we use a ScriptProcessorNode (deprecated but single-file
 * and dependency-free, fine for this demo) and resample to 16 kHz ourselves when
 * the browser won't give us a 16 kHz AudioContext.
 *
 * Lifecycle: on phones the capture can stop underneath us without any error —
 * iOS revokes the track when another app takes audio focus (call, Siri, a
 * video), and suspends the AudioContext on screen lock or app switch. Those
 * are reported through the `onState` callback so the UI can say so instead of
 * showing a red button that streams nothing; resumeMic() is the hook for the
 * page coming back to the foreground.
 */

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 480; // 30 ms @ 16 kHz

let stream = null;
let track = null;
let ctx = null;
let source = null;
let processor = null;

// Pending int16 samples not yet emitted as a full frame.
let frameBuf = new Int16Array(FRAME_SAMPLES);
let frameLen = 0;
let inputRate = TARGET_RATE;

/** Linearly resample a Float32 block from `inputRate` to 16 kHz. */
function resampleTo16k(input) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = TARGET_RATE / inputRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Append int16 samples, emitting onFrame() once per full 30 ms frame. */
function pushInt16(samples, onFrame) {
  let offset = 0;
  while (offset < samples.length) {
    const take = Math.min(FRAME_SAMPLES - frameLen, samples.length - offset);
    frameBuf.set(samples.subarray(offset, offset + take), frameLen);
    frameLen += take;
    offset += take;
    if (frameLen === FRAME_SAMPLES) {
      // Hand off a copy — frameBuf is reused for the next frame.
      onFrame(frameBuf.buffer.slice(0));
      frameLen = 0;
    }
  }
}

/**
 * Start capturing. `onFrame` receives an ArrayBuffer of 480 int16 samples
 * (960 bytes) per call. Returns once the mic is live; throws if permission is
 * denied. Call stopMic() to release the device.
 *
 * `onState(state)` reports what happens to the capture afterwards:
 *   "ended"     the track was taken away (permission revoked, another app took
 *               the mic) — capture is over, call stopMic() and tell the user;
 *   "muted"     the OS paused delivery (call, interruption) — frames stop for
 *               a while, usually followed by "unmuted";
 *   "unmuted"   delivery resumed;
 *   "suspended" the AudioContext stopped (screen lock, app switch); a resume
 *               is attempted here and again from resumeMic().
 */
export async function startMic(onFrame, { onState } = {}) {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  track = stream.getAudioTracks()[0] || null;
  if (track) {
    track.onended = () => onState?.("ended");
    track.onmute = () => onState?.("muted");
    track.onunmute = () => onState?.("unmuted");
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  // Most browsers honor a 16 kHz request; if not, resampleTo16k() covers us.
  ctx = new AC({ sampleRate: TARGET_RATE });
  if (ctx.state === "suspended") await ctx.resume();
  inputRate = ctx.sampleRate;
  ctx.onstatechange = () => {
    if (!ctx) return;
    if (ctx.state !== "running" && ctx.state !== "closed") {
      onState?.("suspended");
      ctx.resume().catch(() => {});
    }
  };

  source = ctx.createMediaStreamSource(stream);
  processor = ctx.createScriptProcessor(2048, 1, 1);

  frameLen = 0;
  processor.onaudioprocess = (e) => {
    const float = resampleTo16k(e.inputBuffer.getChannelData(0));
    const int16 = new Int16Array(float.length);
    for (let i = 0; i < float.length; i++) {
      const s = Math.max(-1, Math.min(1, float[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    pushInt16(int16, onFrame);
  };

  // Chrome only fires onaudioprocess while the node is connected to a sink. We
  // never write to the output buffer, so destination stays silent (no echo).
  source.connect(processor);
  processor.connect(ctx.destination);
}

/** Wake a capture context that the OS suspended (page back in foreground). */
export function resumeMic() {
  if (ctx && ctx.state !== "running" && ctx.state !== "closed") {
    ctx.resume().catch(() => {});
  }
}

/** Whether a capture is currently set up (regardless of its health). */
export function micActive() {
  return stream !== null;
}

/** Stop capturing and release the microphone. */
export function stopMic() {
  if (processor) {
    processor.onaudioprocess = null;
    processor.disconnect();
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (track) {
    track.onended = null;
    track.onmute = null;
    track.onunmute = null;
    track = null;
  }
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  if (ctx) {
    ctx.onstatechange = null;
    ctx.close();
    ctx = null;
  }
  frameLen = 0;
}
