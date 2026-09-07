import { useEffect, useState } from "react";
import useStore from "../store/index.js";
import { BACKEND_URL } from "../config.js";

// Mirrors HuRI/src/interfaces/web_interface.py's KNOWN_MODULES allow-list,
// with a default args block per module (matching HuRI/config/client_full.yaml)
// so ticking a module on gives a working starting point. Which of these are
// actually selectable depends on `/huri-modules` (see below) — this list is
// everything HuRI's code *can* run, not everything *this* instance has.
const MODULES = [
  { name: "mic", args: { vad_agressiveness: 2, silence_duration: 1.0, block_duration: 0.03 } },
  { name: "stt", args: { language: "en", block_duration: 0.03 } },
  { name: "tag", args: {} },
  { name: "emo", args: { block_duration: 0.03 } },
  { name: "eag", args: {} },
  { name: "qag", args: {} },
  { name: "rag", args: { language: "en", tone: "formal", response_format: "paragraph" } },
  { name: "tts", args: {} },
  { name: "gesture", args: {} },
];

function selectionFromModules(modules, availableModules) {
  const selection = {};
  for (const m of MODULES) selection[m.name] = { enabled: false, argsText: "{}" };
  for (const entry of Object.values(modules || {})) {
    if (!selection[entry.name]) continue;
    // availableModules === null means "couldn't ask HuRI" — don't block on it.
    if (availableModules && !availableModules.includes(entry.name)) continue;
    selection[entry.name] = {
      enabled: true,
      argsText: JSON.stringify(entry.args || {}, null, 0),
    };
  }
  return selection;
}

/** Whether every module a preset needs is actually deployed on this HuRI
 * instance (unknown availability = don't block anything). */
function presetIsAvailable(preset, availableModules) {
  if (!availableModules) return true;
  return Object.values(preset).every((m) => availableModules.includes(m.name));
}

export default function EventConfigModal({ onClose }) {
  const sessionConfig = useStore((s) => s.sessionConfig);
  const reconfigure = useStore((s) => s.reconfigure);

  const [presets, setPresets] = useState({});
  const [availableModules, setAvailableModules] = useState(null); // null = unknown
  const [presetName, setPresetName] = useState("custom");
  const [selection, setSelection] = useState(() =>
    selectionFromModules(sessionConfig?.modules, null),
  );
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${BACKEND_URL}/presets`)
      .then((r) => r.json())
      .then(setPresets)
      .catch(() => setPresets({}));
    fetch(`${BACKEND_URL}/huri-modules`)
      .then((r) => r.json())
      .then((data) => setAvailableModules(data.modules ?? null))
      .catch(() => setAvailableModules(null));
  }, []);

  const isAvailable = (name) => !availableModules || availableModules.includes(name);

  const applyPreset = (name) => {
    setPresetName(name);
    if (name === "custom" || !presets[name]) return;
    setSelection(selectionFromModules(presets[name], availableModules));
  };

  const toggleModule = (name) => {
    if (!isAvailable(name)) return;
    setPresetName("custom");
    setSelection((s) => ({ ...s, [name]: { ...s[name], enabled: !s[name].enabled } }));
  };

  const setArgsText = (name, value) => {
    setPresetName("custom");
    setSelection((s) => ({ ...s, [name]: { ...s[name], argsText: value } }));
  };

  const apply = () => {
    const modules = {};
    for (const m of MODULES) {
      const entry = selection[m.name];
      if (!entry?.enabled) continue;
      let args;
      try {
        args = JSON.parse(entry.argsText || "{}");
      } catch {
        setError(`Invalid JSON in "${m.name}" args`);
        return;
      }
      modules[m.name] = { name: m.name, args };
    }
    if (Object.keys(modules).length === 0) {
      setError("Select at least one module.");
      return;
    }
    setError("");
    reconfigure?.(modules);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Event Configuration</div>

        <select
          className="modal-select"
          value={presetName}
          onChange={(e) => applyPreset(e.target.value)}
        >
          <option value="custom">Custom combination</option>
          {Object.entries(presets).map(([name, preset]) => (
            <option key={name} value={name} disabled={!presetIsAvailable(preset, availableModules)}>
              {name}
              {!presetIsAvailable(preset, availableModules) ? " (not deployed here)" : ""}
            </option>
          ))}
        </select>

        <div className="modal-section-title">Event Structure</div>
        {MODULES.map((m) => {
          const entry = selection[m.name] || { enabled: false, argsText: "{}" };
          const available = isAvailable(m.name);
          return (
            <div className="module-row" key={m.name} style={{ opacity: available ? 1 : 0.45 }}>
              <label
                className="module-name"
                title={available ? "" : "Not deployed on the connected HuRI instance"}
              >
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  disabled={!available}
                  onChange={() => toggleModule(m.name)}
                />{" "}
                {m.name}
                {!available && " (unavailable)"}
              </label>
              <input
                type="text"
                value={entry.argsText}
                disabled={!entry.enabled || !available}
                onChange={(e) => setArgsText(m.name, e.target.value)}
                style={{ flex: 1, marginLeft: 12 }}
              />
            </div>
          );
        })}

        {error && <div className="modal-hint" style={{ color: "var(--danger)" }}>{error}</div>}
        {availableModules === null ? (
          <div className="modal-hint">
            Could not reach HuRI to check which modules are deployed — every option is left
            selectable, but an unavailable one will still fail to connect.
          </div>
        ) : (
          <div className="modal-hint">
            Applying reconnects the session with this module combination (HuRI/ATP.xlsx F1/F2).
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-apply" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
