import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import CommandPalette, { PALETTE_EVENT, SHORTCUTS_EVENT, modKey } from "./CommandPalette";
import Icon from "./Icon";

const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable); };
const GO: Record<string, string> = { h: "home", q: "questions", e: "resumes", i: "setup", y: "history", r: "reports", u: "usage", s: "settings" };

export const SHORTCUTS: [string, string[]][] = [
  ["Open the command palette", [modKey, "K"]], ["Show this list", ["?"]], ["Collapse / expand the sidebar", ["["]],
  ["Go to Home", ["G", "H"]], ["Go to Questions", ["G", "Q"]], ["Go to Resumes", ["G", "E"]], ["Go to Interview", ["G", "I"]],
  ["Go to History", ["G", "Y"]], ["Go to Reports", ["G", "R"]], ["Go to Model usage", ["G", "U"]], ["Go to Settings", ["G", "S"]],
  ["Submit your answer", [modKey, "Enter"]], ["Close a dialog or menu", ["Esc"]],
];

/** Global keyboard handling: ⌘/Ctrl+K palette, ? help, [ sidebar, "g" then a letter to jump to a page. */
export default function ShortcutHost({ toggleSidebar }: { toggleSidebar: () => void }) {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const closePalette = useCallback(() => setPalette(false), []);

  useEffect(() => {
    let g = 0;   // time of the last "g"
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setHelp(false); setPalette((p) => !p); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "[") { toggleSidebar(); return; }
      if (e.key === "?") { e.preventDefault(); setHelp((h) => !h); return; }
      if (e.key === "Escape") { setHelp(false); return; }
      const k = e.key.toLowerCase();
      if (k === "g") { g = Date.now(); return; }
      if (g && Date.now() - g < 1200 && GO[k]) { g = 0; window.location.hash = `#/${GO[k]}`; return; }
      g = 0;
    };
    const openPalette = () => { setHelp(false); setPalette(true); };
    const openHelp = () => { setPalette(false); setHelp(true); };
    window.addEventListener("keydown", on);
    window.addEventListener(PALETTE_EVENT, openPalette);
    window.addEventListener(SHORTCUTS_EVENT, openHelp);
    return () => { window.removeEventListener("keydown", on); window.removeEventListener(PALETTE_EVENT, openPalette); window.removeEventListener(SHORTCUTS_EVENT, openHelp); };
  }, [toggleSidebar]);

  return (
    <>
      {palette && <CommandPalette onClose={closePalette} toggleSidebar={toggleSidebar} />}
      {help && createPortal(
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <div className="modal-head"><h2 style={{ margin: 0, fontSize: "1.25rem" }}>Keyboard shortcuts</h2><button className="btn ghost icon" aria-label="Close" onClick={() => setHelp(false)}><Icon name="x" /></button></div>
            <div className="keys">{SHORTCUTS.map(([label, keys]) => <div key={label} className="keyrow"><span>{label}</span><span className="kk">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span></div>)}</div>
          </div>
        </div>, document.body)}
    </>
  );
}
