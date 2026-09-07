import { useEffect, useState } from "react";
import Scene from "./components/Scene.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Composer from "./components/Composer.jsx";
import EventConfigModal from "./components/EventConfigModal.jsx";
import { useWebSocket } from "./hooks/useWebSocket.js";
import useStore from "./store/index.js";
import { BACKEND_URL } from "./config.js";

// A minimal, guaranteed-valid first handshake (mirrors backend/huri_presets.py's
// TEXT_ONLY) so the app connects immediately; the Event Configuration modal
// offers the full named presets (fetched from /presets) to switch afterwards.
const DEFAULT_MODULES = {
  rag: { name: "rag", args: { language: "en", tone: "formal", response_format: "short" } },
};

const STATUS_LABELS = {
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection error",
  closed: "Disconnected",
};

export default function App() {
  const [auth, setAuth] = useState(null); // null = loading

  useEffect(() => {
    fetch(`${BACKEND_URL}/auth/me`, { credentials: "include" })
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => setAuth({ authenticated: false, auth_required: true }));
  }, []);

  if (auth === null) {
    return <CenteredMessage text="Checking sign-in…" />;
  }
  if (auth.auth_required && !auth.authenticated) {
    return (
      <CenteredMessage text="Sign in to test HuRI">
        <a className="modal-apply" style={{ marginTop: 16 }} href={`${BACKEND_URL}/auth/login`}>
          Sign in
        </a>
      </CenteredMessage>
    );
  }
  return <TestingApp user={auth} />;
}

function CenteredMessage({ text, children }) {
  return (
    <div
      style={{
        width: "100vw",
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <div>{text}</div>
      {children}
    </div>
  );
}

function TestingApp({ user }) {
  useWebSocket(DEFAULT_MODULES);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const connectionStatus = useStore((s) => s.connectionStatus);
  const statusMessage = useStore((s) => s.statusMessage);
  const hasModule = useStore((s) => s.hasModule);
  const showAvatar = hasModule("gesture");

  return (
    <div className="app-shell">
      <div className="app-topbar">
        <div className="app-brand">
          <span className="app-brand-icon">🌼</span> HuRI testing console
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className={`status-pill ${connectionStatus}`}
            title={statusMessage}
          >
            {STATUS_LABELS[connectionStatus] ?? connectionStatus}
          </span>
          {user?.authenticated && (
            <a
              href={`${BACKEND_URL}/auth/logout`}
              className="status-pill"
              style={{ textDecoration: "none" }}
            >
              Sign out
            </a>
          )}
        </div>
      </div>

      <div className="app-body">
        <ChatPanel />
        {showAvatar && (
          <div className="avatar-panel">
            <Scene />
          </div>
        )}
      </div>

      <Composer onOpenSettings={() => setSettingsOpen(true)} />

      {settingsOpen && <EventConfigModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
