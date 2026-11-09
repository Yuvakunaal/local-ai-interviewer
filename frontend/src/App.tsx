import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { speaker } from "./audio";
import Icon from "./components/Icon";
import Logo from "./components/Logo";
import ShortcutHost from "./components/ShortcutHost";
import Sidebar from "./components/Sidebar";
import { ChromeCtx, ToastProvider } from "./components/ui";
import { Loading, NetBar, PageBoundary, PageSkeleton } from "./components/Loaders";
import SetupGate, { useSetupReport } from "./components/SetupGate";
import { openSettings } from "./settingsTab";
import { mayNavigate } from "./navGuard";

// Each page is its own file that loads when first needed, so the app opens quickly; the rest are fetched quietly once it is idle.
const pages = {
  home: () => import("./pages/Home"), questions: () => import("./pages/Questions"), setup: () => import("./pages/Setup"), history: () => import("./pages/History"),
  reports: () => import("./pages/Reports"), settings: () => import("./pages/Settings"), usage: () => import("./pages/Usage"),
  interview: () => import("./pages/Interview"), report: () => import("./pages/Report"), resumes: () => import("./pages/Resumes"), resume: () => import("./pages/ResumeDetail"),
};
const Home = lazy(pages.home), Questions = lazy(pages.questions), Setup = lazy(pages.setup), History = lazy(pages.history), Reports = lazy(pages.reports),
  SettingsPage = lazy(pages.settings), UsagePage = lazy(pages.usage), Interview = lazy(pages.interview), ReportPage = lazy(pages.report),
  Resumes = lazy(pages.resumes), ResumeDetail = lazy(pages.resume);
const whenIdle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 4000 }); else setTimeout(fn, 1500);
};

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || "#/home");
  const current = useRef(hash);
  useEffect(() => {
    const on = () => {
      const next = window.location.hash || "#/home";
      if (next !== current.current && !mayNavigate(next)) {           // e.g. unsaved resume edits: stay, the page asks first
        window.history.replaceState(null, "", current.current);
        return;
      }
      current.current = next;
      setHash(next);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const SB_KEY = "lai.sidebar";
const SKIP_KEY = "lai.setup.skip";
const gateSkipped = () => { try { return sessionStorage.getItem(SKIP_KEY) === "1"; } catch { return false; } };
const readCollapsed = () => { try { return localStorage.getItem(SB_KEY) === "collapsed"; } catch { return false; } };

export default function App() {
  const hash = useHash();
  const [full, setFull] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [, route = "home", arg] = hash.replace(/^#\/?/, "/").split("/");
  const first = useSetupReport();                               // checked once when the app opens
  const [skipped, setSkipped] = useState(gateSkipped);
  const id = arg ? Number(arg) : NaN;

  const toggle = useCallback(() => setCollapsed((c) => { const n = !c; try { localStorage.setItem(SB_KEY, n ? "collapsed" : "open"); } catch { /* ignore */ } return n; }), []);
  useEffect(() => {   // Esc closes the phone drawer ("[", the palette and page shortcuts live in <ShortcutHost />)
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => setMobileOpen(false), [hash]);
  useEffect(() => { api.health().then((h) => speaker.setEngine(h.tts.engine)).catch(() => {}); }, []);
  useEffect(() => { whenIdle(() => { Object.values(pages).forEach((load) => { void load().catch(() => {}); }); }); }, []);   // Phonon or the computer's own voices?

  let page;
  if (route === "interview" && id) page = <Interview key={id} id={id} />;
  else if (route === "report" && id) page = <ReportPage key={id} id={id} />;
  else if (route === "resumes" && id) page = <ResumeDetail key={id} id={id} />;
  else if (route === "resumes") page = <Resumes />;
  else if (route === "setup") page = <Setup />;
  else if (route === "history") page = <History />;
  else if (route === "reports") page = <Reports />;
  else if (route === "settings") page = <SettingsPage />;
  else if (route === "usage") page = <UsagePage />;
  else if (route === "questions") page = <Questions />;
  else page = <Home />;
  const fullscreen = full && route === "interview";

  const leaveGate = (to?: () => void) => { try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* ignore */ } setSkipped(true); if (route === "welcome") window.location.hash = "#/home"; to?.(); };
  if (first.loading && !skipped) return <ToastProvider><NetBar /><Loading label="Checking your computer…" /></ToastProvider>;
  const showGate = (route === "welcome" || (!skipped && first.report?.needs_setup)) && first.report;
  if (showGate) return <ToastProvider><NetBar /><SetupGate initial={first.report!} manual={route === "welcome"} onContinue={() => leaveGate()} onCloud={() => leaveGate(() => openSettings("ai"))} /></ToastProvider>;

  return (
    <ToastProvider>
      <ChromeCtx.Provider value={setFull}>
        <NetBar />
        <ShortcutHost toggleSidebar={toggle} />
        <div className={`shell ${fullscreen ? "full" : ""} ${collapsed ? "collapsed" : ""}`}>
          {!fullscreen && <Sidebar route={route} collapsed={collapsed} onToggle={toggle} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />}
          {!fullscreen && (
            <header className="mobilebar">
              <button className="btn icon" aria-label="Open menu" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
              <Logo size={30} /><b>AI Interviewer</b>
            </header>
          )}
          <main className={fullscreen ? "bare" : ""}><div className="page" key={`${route}/${arg ?? ""}`}><PageBoundary><Suspense fallback={route === "interview" ? <Loading label="Opening your interview…" /> : <PageSkeleton />}>{page}</Suspense></PageBoundary></div></main>
        </div>
      </ChromeCtx.Provider>
    </ToastProvider>
  );
}
