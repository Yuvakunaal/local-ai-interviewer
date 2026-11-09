/** Lets a link elsewhere (Home, Setup) open Settings straight on a given tab. */
const KEY = "lai.settings.tab";
export type SettingsTab = "services" | "ai" | "profile" | "rubric";
export const openSettings = (tab: SettingsTab) => { try { sessionStorage.setItem(KEY, tab); } catch { /* ignore */ } window.location.hash = "#/settings"; };
export const takeSettingsTab = (): SettingsTab | null => { try { const v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return v === "ai" || v === "profile" || v === "rubric" || v === "services" ? v : null; } catch { return null; } };
