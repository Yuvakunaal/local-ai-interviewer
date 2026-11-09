import { Component, useEffect, useState, type ReactNode } from "react";
import { subscribeBusy } from "../api";
import Icon from "./Icon";

/** Thin bar at the very top of the window while the app waits for the server. It only appears after a short delay, so quick requests never flash it. */
export function NetBar() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeBusy((n) => {
      if (n > 0) { timer ??= setTimeout(() => setOn(true), 350); }
      else { if (timer) clearTimeout(timer); timer = undefined; setOn(false); }
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);
  return <div className={`netbar ${on ? "on" : ""}`} aria-hidden="true"><i /></div>;
}

/** What a page looks like before its data arrives: a heading, a row of figures and two cards (no layout jump afterwards). */
export function PageSkeleton() {
  return (
    <div className="page-skel" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <span className="skel" style={{ width: 240, height: 30 }} />
      <span className="skel" style={{ width: 360, maxWidth: "70%", height: 14, marginTop: 12 }} />
      <div className="kpis" style={{ marginTop: 24 }} aria-hidden>{[0, 1, 2, 3].map((i) => <span key={i} className="skel skel-kpi" />)}</div>
      <span className="skel skel-card" aria-hidden />
      <span className="skel skel-card" aria-hidden />
    </div>
  );
}

/** Placeholders for stacked cards (Settings tabs, forms). */
export function CardsSkeleton({ n = 2, label = "Loading…" }: { n?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="cards-skel">
      <span className="sr-only">{label}</span>
      {Array.from({ length: n }, (_, i) => <span key={i} className="skel skel-card" aria-hidden />)}
    </div>
  );
}

/** A centred spinner with a sentence, for waits that have no page layout to imitate. */
export function Loading({ label }: { label: string }) {
  return <div className="loading-box" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

/** A new version of the app may have replaced the page files this tab still points to: offer a reload instead of a blank screen. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice error" role="alert" style={{ marginTop: 24 }}>
        <b>This page could not be loaded.</b> The app may have been updated or restarted.{" "}
        <button className="linkbtn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

/** A Refresh button that shows it is working (spinner, disabled) until the refresh finishes. */
export function RefreshButton({ onRefresh, label = "Refresh" }: { onRefresh: () => Promise<unknown> | void; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn" disabled={busy} aria-busy={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}>
      {busy ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden="true" /> : <Icon name="refresh" />}{busy ? "Refreshing…" : label}
    </button>
  );
}
