/**
 * Streaming audio playback.
 *
 * Audio arrives as a sequence of float32 PCM chunks, each tagged with a `pts`
 * (presentation timestamp in seconds from the start of the utterance). We
 * schedule every chunk on a single AudioContext so it plays at `startTime + pts`
 * — `startTime` being the context-clock instant that corresponds to pts = 0.
 *
 * The same `startTime` is exposed via getElapsed() so the animation loop can
 * look up motion frames against the exact audio clock, keeping voice and
 * gesture in sync (they share the same pts timeline).
 */

let ctx = null;
let startTime = null; // ctx.currentTime that maps to pts = 0
let endsAt = 0; // latest ctx time at which scheduled audio finishes
const sources = new Set();
let keepAlive = null; // silent looping source; stops iOS re-suspending an idle context

// Small lead so the first chunk is scheduled slightly in the future, leaving
// room for decode/connect jitter instead of starting in the past.
const LEAD = 0.15;

/** Get (creating/resuming) the shared AudioContext. Call from a user gesture. */
export function ensureContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    unlock(); // iOS: prime the output route from inside this gesture
    startKeepAlive(); // iOS: keep it "running" through the thinking gap
  }
  // "interrupted" is an iOS-only state (e.g. after the mic context closes);
  // treat anything but "running" as needing a resume.
  if (ctx.state !== "running") ctx.resume();
  return ctx;
}

// iOS opens the actual audio output route only if a buffer is *started* inside
// the unlocking user gesture. resume() alone leaves the context "running" but
// silent, so the first real TTS chunk (scheduled later, from a WebSocket
// callback) never makes sound. Playing a 1-sample silent buffer here fixes that.
function unlock() {
  try {
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  } catch {
    /* non-fatal: worst case we fall back to resume() only */
  }
}

// iOS aggressively suspends a context that produces no sound — during HuRI's
// multi-second "thinking" gap, or when the mic AudioContext is closed after a
// voice turn (they share one AVAudioSession). Once suspended, resume() outside a
// user gesture is a no-op, so the next chunk plays into a silenced context. A
// looping all-zero buffer keeps the context awake without emitting anything.
function startKeepAlive() {
  if (keepAlive) return;
  try {
    const b = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * 0.5)), ctx.sampleRate);
    keepAlive = ctx.createBufferSource();
    keepAlive.buffer = b; // zero-filled → truly silent
    keepAlive.loop = true;
    keepAlive.connect(ctx.destination);
    keepAlive.start(0);
  } catch {
    keepAlive = null;
  }
}

/** Stop anything playing and reset the clock for a new utterance. */
export function resetUtterance() {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  startTime = null;
  endsAt = 0;
}

/** Schedule one audio chunk at its pts offset. */
export function scheduleChunk(float32, sampleRate, pts) {
  if (!float32 || float32.length === 0) return;
  const c = ensureContext();
  if (startTime === null) startTime = c.currentTime + LEAD;

  // Where this chunk should start on the shared pts timeline.
  let when = startTime + pts;

  // Underrun: the producer fell behind its pts slot. This is the cold-first-
  // request case — HuRI stalls for seconds, then delivers a backlog at once.
  // Do NOT clamp each late chunk to `currentTime`: that collapses the whole
  // backlog onto one instant, so chunks overlap and play out of order (the
  // "multiple audio at once / wrong order" bug). Instead re-anchor the entire
  // timeline forward by the shortfall. Because TTS pts are contiguous, the
  // backlog then plays strictly back-to-back from now; and because getElapsed()
  // reads this same `startTime`, the motion clock shifts with the audio, so
  // gesture stays locked to speech instead of desyncing. The visible cost is a
  // brief pause on a stall rather than a garbled pile-up. `startTime` only ever
  // moves forward, keeping the schedule monotonic.
  if (when < c.currentTime) {
    startTime += c.currentTime - when;
    when = c.currentTime;
  }

  const buffer = c.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);

  src.start(when);
  endsAt = Math.max(endsAt, when + buffer.duration);

  sources.add(src);
  src.onended = () => sources.delete(src);
}

/** Seconds elapsed since pts = 0, or null if nothing has been scheduled. */
export function getElapsed() {
  if (!ctx || startTime === null) return null;
  return ctx.currentTime - startTime;
}

/** Seconds of audio still scheduled to play, from now. */
export function getRemaining() {
  if (!ctx || startTime === null) return 0;
  return Math.max(0, endsAt - ctx.currentTime);
}

/**
 * One-shot playback of a complete, already-known buffer — for replaying a
 * past chat bubble's recorded/generated audio on demand (MessageBubble's
 * play button), independent of the live streaming pts timeline above.
 * Returns a stop() function.
 */
export function playBuffer(float32, sampleRate) {
  const c = ensureContext();
  const buffer = c.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  src.start();
  return () => {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  };
}
