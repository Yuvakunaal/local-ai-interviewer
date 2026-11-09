import { useEffect, useRef } from "react";

/** Calls `fn` every `ms` while `active` is true and the tab is visible. Cleanup-safe: stops on unmount or when `active` turns false,
 *  never overlaps two calls, and ignores results that arrive after the component is gone (the caller's `fn` may check `alive()`). */
export function usePoll(fn: (alive: () => boolean) => Promise<unknown> | void, ms: number, active: boolean) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    let live = true, busy = false;
    const tick = async () => {
      if (busy || document.hidden || !live) return;
      busy = true;
      try { await saved.current(() => live); } catch { /* the next tick tries again */ } finally { busy = false; }
    };
    const t = setInterval(() => { void tick(); }, ms);
    return () => { live = false; clearInterval(t); };
  }, [ms, active]);
}
