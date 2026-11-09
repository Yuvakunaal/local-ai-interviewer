import { useSyncExternalStore } from "react";

/**
 * Colour theme: "light" (default, the approved look), "dark", or "system" (follow the operating system).
 * The preference is stored in localStorage; index.html applies it before the first paint so there is no flash.
 */
export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "lai.theme";
const prefersDark = () => { try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } };

export const readPref = (): ThemePref => {
  try { const v = localStorage.getItem(KEY); return v === "dark" || v === "system" ? v : "light"; } catch { return "light"; }
};
export const resolveTheme = (pref: ThemePref, dark = prefersDark()): ResolvedTheme => (pref === "system" ? (dark ? "dark" : "light") : pref);

let state = { pref: readPref(), resolved: resolveTheme(readPref()) };
const listeners = new Set<() => void>();

function apply() {
  state = { pref: state.pref, resolved: resolveTheme(state.pref) };
  document.documentElement.dataset.theme = state.resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.resolved === "dark" ? "#0d1020" : "#5648f0");
  listeners.forEach((l) => l());
}

export function setThemePref(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore: the choice just won't persist */ }
  state = { ...state, pref };
  apply();
}

/** Cycle light -> dark -> system -> light (used by the quick toggle). */
export const nextPref = (p: ThemePref): ThemePref => (p === "light" ? "dark" : p === "dark" ? "system" : "light");

export function initTheme() {
  apply();
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.pref === "system") apply(); }); } catch { /* old browser */ }
}

export function useTheme() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
}
