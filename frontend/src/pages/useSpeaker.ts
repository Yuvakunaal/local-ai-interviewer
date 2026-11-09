import { useEffect, useState, useSyncExternalStore } from "react";
import { speaker } from "../audio";
import { browserSpeech, type SystemVoice } from "../systemVoices";

export function useSpeaker() {
  return useSyncExternalStore(speaker.subscribe, speaker.getSnapshot);
}

/** The offline voices this computer offers through the browser (null while loading; [] when there are none). */
export function useSystemVoices(enabled: boolean): SystemVoice[] | null {
  const [voices, setVoices] = useState<SystemVoice[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const sys = browserSpeech();
    if (!sys) { setVoices([]); return; }
    sys.voices().then((v) => live && setVoices(v)).catch(() => live && setVoices([]));
    return () => { live = false; };
  }, [enabled]);
  return voices;
}

/** "Microsoft David - English (United States)" -> "David" */
export const shortVoiceName = (name: string) => name.replace(/^Microsoft\s+/i, "").replace(/\s+-\s+.*$/, "").replace(/\s+\(.*\)$/, "");
