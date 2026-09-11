import { useEffect, useRef, useState } from "react";
import Scene from "./components/Scene.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Composer from "./components/Composer.jsx";
import EventConfigModal from "./components/EventConfigModal.jsx";
import LauncherPanel from "./components/LauncherPanel.jsx";
import UserIdPill from "./components/UserIdPill.jsx";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useAudioLifecycle } from "./hooks/useAudioLifecycle.js";
import { useHuriStatus } from "./hooks/useHuriStatus.js";
import useStore from "./store/index.js";
import { BACKEND_URL } from "./config.js";
import { loadSessionModules, modulesEqual, saveSessionModules } from "./persist.js";

// A minimal, guaranteed-valid first handshake (mirrors backend/huri_presets.py's
// TEXT_ONLY) so the app connects immediately; the Event Configuration modal
// offers the full named presets (fetched from /presets) to switch afterwards.
// Only used the very first time on a device — after that the last applied
// combination is remembered (persist.js) and seeds the handshake instead.
const DEFAULT_MODULES = {
  rag: { name: "rag", args: { language: "en", tone: "formal", response_format: "short" } },
};

const STATUS_LABELS = {
  idle: "Waiting for HuRI",
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
  // HuRI is launched on demand from the Control Panel rather than
  // auto-starting on page load (it's a real local process, not something to
  // spin up just because a tab was opened) — so the panel opens by itself on
  // first load, asking the visitor to start HuRI, and the client websocket
  // only connects once the launcher reports it's actually running.
  const { status: huriStatus } = useHuriStatus();
  const huriRunning = huriStatus?.status === "running";

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(true);

  // Auto-close the panel the moment HuRI transitions to running, whether that
  // was this visitor clicking Start or an instance already running elsewhere
  // being detected — but only once, so re-opening the panel later (to stop
  // HuRI, check logs, etc) doesn't get immediately closed out from under them.
  const autoClosedRef = useRef(false);
  useEffect(() => {
    if (huriRunning && !autoClosedRef.current) {
      autoClosedRef.current = true;
      setLauncherOpen(false);
    }
  }, [huriRunning]);

  // Whatever combination this device last applied (Event Configuration Apply,
  // or a `?preset=` tab) — so a refresh comes back with the same modules
  // rather than dropping to rag-only and making the tester pick again.
  const [initialModules] = useState(() => loadSessionModules() || DEFAULT_MODULES);
  useWebSocket(initialModules, { enabled: huriRunning });
  useAudioLifecycle();

  const connectionStatus = useStore((s) => s.connectionStatus);
  const statusMessage = useStore((s) => s.statusMessage);
  const hasModule = useStore((s) => s.hasModule);
  const reconfigure = useStore((s) => s.reconfigure);
  const clearMessages = useStore((s) => s.clearMessages);
  const hasMessages = useStore((s) => s.messages.length > 0);
  const showAvatar = hasModule("gesture");

  // A tab opened from the Control Panel's "Open client tab" (LauncherPanel.jsx)
  // carries `?preset=<name>` — apply it once `reconfigure` is wired up (after
  // the initial handshake) so this client starts pre-configured instead of
  // requiring a manual Event Configuration step. The URL wins over what the
  // device remembered (it's the more explicit intent); when the two already
  // agree — the usual case on a refresh — the first handshake used it, so
  // don't tear that session down just to open an identical one.
  const appliedPresetFromUrl = useRef(false);
  useEffect(() => {
    if (appliedPresetFromUrl.current || !reconfigure) return;
    const presetName = new URLSearchParams(window.location.search).get("preset");
    if (!presetName) return;
    appliedPresetFromUrl.current = true;
    fetch(`${BACKEND_URL}/presets`, { credentials: "include" })
      .then((r) => r.json())
      .then((presets) => {
        const preset = presets[presetName];
        if (!preset) return;
        if (modulesEqual(preset, initialModules)) saveSessionModules(preset);
        else reconfigure(preset);
      })
      .catch(() => {});
  }, [reconfigure, initialModules]);

  return (
    <div className="app-shell">
      <div className="app-topbar">
        <div className="app-brand">
          <span className="app-brand-icon">🌼</span>
          <span className="app-brand-text">HuRI testing console</span>
        </div>
        <div className="app-topbar-actions">
          <span
            className={`status-pill ${connectionStatus}`}
            title={statusMessage}
          >
            {STATUS_LABELS[connectionStatus] ?? connectionStatus}
          </span>
          <UserIdPill userId={user?.user_id} source={user?.user_id_source} />
          <button
            type="button"
            className="status-pill status-pill-button"
            onClick={() => setLauncherOpen(true)}
            title="Launch HuRI with a config and connect client(s) (HuRI/ATP.xlsx F1-F11)"
          >
            <span className="hide-narrow">HuRI </span>Control Panel
          </button>
          <button
            type="button"
            className="status-pill status-pill-button"
            onClick={clearMessages}
            disabled={!hasMessages}
            title="Clear the conversation shown here (it is remembered on this device across reloads)"
          >
            🗑<span className="hide-narrow"> Clear chat</span>
          </button>
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
      {launcherOpen && <LauncherPanel onClose={() => setLauncherOpen(false)} />}
    </div>
  );
}
