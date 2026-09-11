import { useEffect, useState } from "react";

// How backend/main.py's resolve_user_id() picked the id — what the tester
// needs to know to interpret "HuRI remembers/forgot me".
const SOURCE_LABELS = {
  oidc: "your signed-in account",
  env: "pinned by HURI_USER_ID on the backend (every visitor shares it)",
  device: "this device/browser (kept in a cookie; another phone or browser gets its own)",
  shared: "the backend's shared fallback id (every visitor shares it)",
};

/**
 * The HuRI `user_id` (RAG memory partition) this browser's sessions use —
 * from /auth/me, see backend/main.py's RAG identity notes. Shown short with
 * the full id on hover; click copies it, e.g. to pass as `--user-id` when
 * ingesting documents meant for this device's partition.
 */
export default function UserIdPill({ userId, source }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!userId) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
    } catch {
      // No clipboard (plain-HTTP LAN page): the title still shows the full id.
      window.prompt("HuRI user_id", userId);
    }
  };

  return (
    <button
      type="button"
      className="status-pill status-pill-button user-id-pill"
      onClick={copy}
      title={`HuRI user_id: ${userId}\nIdentity: ${SOURCE_LABELS[source] ?? source ?? "unknown"}\nClick to copy`}
    >
      👤 <span className="user-id-short">{copied ? "copied" : userId.slice(0, 8)}</span>
    </button>
  );
}
