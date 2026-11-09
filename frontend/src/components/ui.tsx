import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "./Icon";

// ------------------------------------------------------------------ toasts
interface Toast { id: number; kind: "info" | "error" | "ok"; text: string }
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = next.current++;
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ modal / confirm
export function Modal({ title, onClose, children, narrow }: { title: string; onClose: () => void; children: ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered into <body> so it is always centred in the window (an ancestor with a transform would otherwise become its containing block).
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${narrow ? "narrow" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2 style={{ margin: 0, fontSize: "1.35rem" }}>{title}</h2><button className="btn ghost icon" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, message, confirmLabel = "Confirm", danger, onConfirm, onCancel }: {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} narrow>
      <div className="muted" style={{ marginBottom: 18 }}>{message}</div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onCancel} autoFocus>Cancel</button>
        <button className={`btn ${danger ? "danger solid" : "primary"}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ shell chrome (sidebar hidden on the full-screen interview)
export const ChromeCtx = createContext<(full: boolean) => void>(() => {});
export function useFullscreen(on: boolean) {
  const set = useContext(ChromeCtx);
  useEffect(() => { set(on); return () => set(false); }, [on, set]);
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <span className="switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><i /></span>;
}

/** Small dropdown menu (used for the secondary question actions). */
export function Menu({ trigger, label, children }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="btn icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{trigger}</button>
      {open && <div className="menu-pop" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Segmented control (radiogroup). */
export function Seg<T extends string | number>({ value, onChange, options, label, size }: {
  value: T; onChange: (v: T) => void; label: string; size?: "sm";
  options: { value: T; label: ReactNode; icon?: IconName; aria?: string; disabled?: boolean }[];
}) {
  return (
    <div className={`seg ${size ?? ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} aria-label={o.aria} disabled={o.disabled}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>{o.icon && <Icon name={o.icon} />}{o.label}</button>
      ))}
    </div>
  );
}

/** Large selectable option cards (radiogroup) with icon, title and description. */
export function OptionCards<T extends string | number>({ value, onChange, options, label, cols }: {
  value: T; onChange: (v: T) => void; label: string; cols?: number;
  options: { value: T; title: string; desc?: string; icon: IconName; aria?: string }[];
}) {
  return (
    <div className="ocards" data-cols={cols} role="radiogroup" aria-label={label} style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` } : undefined}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} aria-label={o.aria} className={`ocard ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          <span className="oc-ic"><Icon name={o.icon} /></span>
          <span className="oc-t">{o.title}</span>
          {o.desc && <span className="oc-d">{o.desc}</span>}
          <span className="oc-check" aria-hidden><Icon name="check" /></span>
        </button>
      ))}
    </div>
  );
}

/** Titled section card used by the customization forms. */
export function Section({ icon, title, desc, step, children }: { icon: IconName; title: string; desc?: string; step?: number; children: ReactNode }) {
  return (
    <section className={`sec${step ? ` step-${step}` : ""}`}>
      <header className="sec-h"><span className="sec-ic"><Icon name={icon} /></span><div><h2>{step ? <span className="sec-n">{step}</span> : null}{title}</h2>{desc && <p>{desc}</p>}</div></header>
      <div className="sec-b">{children}</div>
    </section>
  );
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? <div className="notice error" role="alert">{error}</div> : null;
}

// ------------------------------------------------------------------ hooks
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);
  const reload = useCallback(async () => {
    const my = ++tick.current;
    setLoading(true);
    try {
      const d = await fn();
      if (my === tick.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === tick.current) setError((e as Error).message);
    } finally {
      if (my === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
export const scoreClass = (s: number | null | undefined) => (s == null ? "" : s >= 7 ? "good" : s >= 5 ? "mid" : "low");
export const fmtShort = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) : "—");
export const minutesBetween = (a: string | null, b: string | null) => (a && b ? Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)) : null);
const TOPIC_CLASSES = ["t0", "t1", "t2", "t3", "t4", "t5"];
export const topicClass = (t: string) => TOPIC_CLASSES[[...t].reduce((n, c) => n + c.charCodeAt(0), 0) % TOPIC_CLASSES.length];
