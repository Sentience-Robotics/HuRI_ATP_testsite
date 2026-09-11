// What this device remembers across page loads (localStorage, so it survives a
// refresh, a closed tab, and a phone browser evicting the page — but stays on
// this browser, alongside the per-device user_id cookie the backend issues):
//
//   - the module combination of the last session (so a reload re-handshakes
//     with what the tester picked, not the rag-only default), and
//   - the chat transcript (so a reload doesn't wipe the conversation and show
//     the empty-state greeting again).
//
// Everything is best-effort: storage can be missing, full, or blocked (private
// mode), and a stale/garbled value must never break the app — every read is
// validated and falls back to "nothing remembered".

const MODULES_KEY = "huri.session.modules.v1";
const MESSAGES_KEY = "huri.chat.messages.v1";

function read(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode / disabled storage: remembering is a convenience,
    // not a requirement.
  }
}

/** Is this a `{tag: {name, args}}` block run_browser_session would accept? */
export function isModulesBlock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every(
      (m) =>
        m &&
        typeof m === "object" &&
        typeof m.name === "string" &&
        (m.args === undefined || (m.args && typeof m.args === "object")),
    )
  );
}

export function loadSessionModules() {
  const stored = read(MODULES_KEY);
  return isModulesBlock(stored) ? stored : null;
}

export function saveSessionModules(modules) {
  write(MODULES_KEY, isModulesBlock(modules) ? modules : null);
}

/** Same module combination, regardless of tag order / key order inside args. */
export function modulesEqual(a, b) {
  if (!isModulesBlock(a) || !isModulesBlock(b)) return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every(
    (k) => a[k].name === b[k].name && stableStringify(a[k].args || {}) === stableStringify(b[k].args || {}),
  );
}

function stableStringify(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

/** Restore the transcript, as far as it can be: audio (mic recordings, TTS
 * speech — raw Float32 samples) is never stored, and a reply that was still
 * streaming when the page went away is closed off with whatever text it had
 * (dropped entirely if it had none). */
export function loadMessages() {
  const stored = read(MESSAGES_KEY);
  if (!Array.isArray(stored)) return [];
  const messages = [];
  for (const m of stored) {
    if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (m.role === "assistant" && !text) continue;
    messages.push({
      id: m.id,
      role: m.role,
      text,
      topic: m.topic,
      emotion: m.emotion || null,
      audio: null,
      createdAt: Number(m.createdAt) || Date.now(),
      completedAt: Number(m.completedAt) || Number(m.createdAt) || Date.now(),
      pending: false,
      expanded: false,
    });
  }
  return messages;
}

export function saveMessages(messages) {
  write(
    MESSAGES_KEY,
    messages.map(({ id, role, text, topic, emotion, createdAt, completedAt }) => ({
      id,
      role,
      text,
      topic,
      emotion: emotion || null,
      createdAt,
      completedAt,
    })),
  );
}

export function clearStoredMessages() {
  write(MESSAGES_KEY, null);
}
