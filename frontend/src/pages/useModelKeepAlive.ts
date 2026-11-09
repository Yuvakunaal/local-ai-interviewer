import { useEffect } from "react";
import { api } from "../api";

export const FIRST_PING_MS = 6_000;
export const PING_EVERY_MS = 4 * 60_000;   // shorter than Ollama's 10-minute idle timer
export const MAX_PINGS = 7;                // about 24 minutes per question, so a forgotten tab never holds the memory forever

/**
 * Keeps the AI model loaded while an interview is open.
 * The first call (6 s in) loads it early, so the slow, memory-hungry load does not land in the middle of "Evaluating…";
 * later calls stop it being unloaded while you think. Pings only happen while this tab is visible.
 */
export function useModelKeepAlive(active: boolean, resetKey?: unknown, ping: () => Promise<unknown> = api.warm) {
  useEffect(() => {
    if (!active) return;
    let sent = 0;
    const send = () => {
      if (document.visibilityState !== "visible" || ++sent > MAX_PINGS) return;
      ping().catch(() => { /* an optimisation only: ignore failures */ });
    };
    const first = setTimeout(send, FIRST_PING_MS);
    const every = setInterval(send, PING_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [active, resetKey, ping]);
}
