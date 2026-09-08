import { useCallback, useEffect, useState } from "react";
import { BACKEND_URL } from "../config.js";

const POLL_MS = 2000;

/**
 * Polls backend/huri_launcher.py's status (via main.py's
 * /launcher/huri/status) so the app knows whether the local HuRI process is
 * up before opening a client session against it. `status` is `null` while
 * the first request is in flight.
 *
 * Shared by App.jsx (gates the client websocket) and LauncherPanel.jsx (the
 * control panel showing/driving that same status), so both agree on when
 * HuRI is actually ready without racing each other's polls.
 */
export function useHuriStatus() {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(() => {
    fetch(`${BACKEND_URL}/launcher/huri/status`, { credentials: "include" })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { status, refresh };
}
