import useStore from "../store/index.js";
import Waveform from "./Waveform.jsx";

function formatTimestamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} | ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatScores(scores) {
  if (!scores) return [];
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => `${capitalize(label)} ${(value * 100).toFixed(1)}%`);
}

function capitalize(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * One chat turn. User bubbles can expand to show the linked emotion read
 * (HuRI/ATP.xlsx F10/F11); both roles show an inline waveform when audio is
 * attached (recorded mic input for the user, generated TTS speech for HuRI).
 */
export default function MessageBubble({ message }) {
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const isUser = message.role === "user";
  const canExpand = isUser && !!message.emotion;

  const durationLabel =
    !isUser && message.completedAt
      ? `Took ${Math.max(1, Math.round((message.completedAt - message.createdAt) / 1000))}s`
      : null;

  return (
    <div className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className={`bubble-avatar ${isUser ? "user" : "assistant"}`}>
        {isUser ? "🙂" : "🌼"}
      </div>
      <div className="bubble-stack">
        <div className={`bubble ${isUser ? "user" : "assistant"}`}>
          {message.text || (message.pending ? "…" : "")}
          {message.audio && (
            <Waveform samples={message.audio.samples} sampleRate={message.audio.sampleRate} />
          )}

          {canExpand && message.expanded && (
            <div className="bubble-detail">
              <div>
                <span className="detail-label">Emotion: </span>
                {capitalize(message.emotion.label)} (
                {(message.emotion.confidence * 100).toFixed(0)}%)
                <div className="emotion-scores">
                  {formatScores(message.emotion.scores).map((s) => (
                    <span key={s}>{s}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {canExpand && (
            <div>
              <button
                type="button"
                className="bubble-toggle"
                onClick={() => toggleExpanded(message.id)}
              >
                {message.expanded ? "shrink" : "expand for more details"}
              </button>
            </div>
          )}
        </div>
        <div className="bubble-meta">
          <span>{formatTimestamp(message.createdAt)}</span>
          {durationLabel && <span>{durationLabel}</span>}
        </div>
      </div>
    </div>
  );
}
