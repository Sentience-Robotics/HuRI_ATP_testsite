import { useEffect, useState } from "react";
import { BACKEND_URL } from "../config.js";

/** Which modules the connected HuRI instance actually has deployed (see
 * backend/main.py's /huri-modules, which proxies HuRI/src/core/huri.py's
 * "/modules" route) — `null` means "couldn't ask" (don't block on it), as
 * opposed to an empty array (asked, HuRI has nothing registered). */
export function useAvailableModules() {
  const [availableModules, setAvailableModules] = useState(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/huri-modules`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setAvailableModules(data.modules ?? null))
      .catch(() => setAvailableModules(null));
  }, []);

  return availableModules;
}

/** Whether every module a preset needs is actually deployed on this HuRI
 * instance (unknown availability = don't block anything). */
export function presetIsAvailable(preset, availableModules) {
  if (!availableModules) return true;
  return Object.values(preset).every((m) => availableModules.includes(m.name));
}
