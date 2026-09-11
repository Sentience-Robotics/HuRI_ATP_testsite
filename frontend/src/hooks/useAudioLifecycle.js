import { useEffect } from "react";
import { resumePlayback } from "../audio/playback.js";
import { resumeMic } from "../audio/microphone.js";

/**
 * Wake both AudioContexts when the page comes back to the foreground.
 *
 * Phones suspend a page's audio on screen lock, app switch or an incoming
 * call, and nothing resumes it by itself: the mic context stops delivering
 * frames, and the playback clock freezes (which is what `getRemaining()`
 * reads — see audio/playback.js). resume() outside a user gesture is allowed
 * once the context was unlocked by one earlier, which the mic/send gestures
 * did.
 */
export function useAudioLifecycle() {
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      resumePlayback();
      resumeMic();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);
}
