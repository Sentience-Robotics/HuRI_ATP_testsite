import { useMemo, useRef, useState } from "react";
import { playBuffer } from "../audio/playback.js";

const BAR_COUNT = 32;
const MIN_PX = 3;
const MAX_PX = 22;

/** Downsample `samples` into BAR_COUNT peak-amplitude bars for a compact
 * inline waveform preview. */
function computePeaks(samples) {
  const bars = new Array(BAR_COUNT).fill(0);
  if (!samples || samples.length === 0) return bars;
  const bucket = Math.max(1, Math.floor(samples.length / BAR_COUNT));
  for (let b = 0; b < BAR_COUNT; b++) {
    let peak = 0;
    const start = b * bucket;
    const end = Math.min(samples.length, start + bucket);
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]));
    bars[b] = peak;
  }
  return bars;
}

/** Inline waveform + play/stop control for a message bubble's attached
 * audio (recorded mic input or generated TTS speech). */
export default function Waveform({ samples, sampleRate }) {
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef(null);

  const peaks = useMemo(() => computePeaks(samples), [samples]);

  const toggle = () => {
    if (playing) {
      stopRef.current?.();
      stopRef.current = null;
      setPlaying(false);
      return;
    }
    stopRef.current = playBuffer(samples, sampleRate);
    setPlaying(true);
    const durationMs = (samples.length / sampleRate) * 1000;
    setTimeout(() => {
      stopRef.current = null;
      setPlaying(false);
    }, durationMs);
  };

  if (!samples || samples.length === 0) return null;

  return (
    <div className="waveform-row">
      <button
        type="button"
        className="waveform-play"
        onClick={toggle}
        aria-label={playing ? "Stop" : "Play"}
      >
        {playing ? "■" : "▶"}
      </button>
      <div className="waveform-bars">
        {peaks.map((p, i) => (
          <span key={i} style={{ height: `${MIN_PX + p * (MAX_PX - MIN_PX)}px` }} />
        ))}
      </div>
    </div>
  );
}
