import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../api";
import { ToastProvider } from "../components/ui";
import { takeIntent } from "../intent";
import { mayNavigate, setNavGuard } from "../navGuard";
import ResumeDetail from "../pages/ResumeDetail";
import { DELETE_NOTE } from "../pages/Resumes";
import type { Resume } from "../types";
import api from "./fixtures/resume-detail-api.json";      // real responses from the backend: backend/tests/test_report_fixture.py

type Json = Record<string, unknown>;
type Reply = { status: number; body: unknown };
const fx = api as unknown as Record<"ready" | "saved" | "renamed" | "reparsing" | "reparsed" | "failed", Resume> & typeof api;
const EDITED = (fx.saved.profile as NonNullable<Resume["profile"]>).summary;     // the summary the backend saved
const ORIGINAL = (fx.ready.profile as NonNullable<Resume["profile"]>).summary;

/** "METHOD /path" -> what the fake server answers. A promise holds the answer back (to see the loading state). */
let routes: Record<string, Reply | Promise<Reply>> = {};
const sent: { method: string; path: string; body: Json | null }[] = [];
const ok = (body: unknown): Reply => ({ status: 200, body });
const writes = (method: string) => sent.filter((s) => s.method === method);

/** The real API client talks to a fake server that answers with what the backend really returned. */
function serve(resume: Resume, more: Record<string, Reply | Promise<Reply>> = {}) {
  const at = `/api/resumes/${resume.id}`;
  routes = { "GET /api/ai": ok(api.ai), [`GET ${at}`]: ok(resume), [`GET ${at}/text`]: ok(api.text), [`GET ${at}/intelligence`]: ok(api.intelligence), ...more };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    if (method !== "GET") sent.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = await (routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: "not_found", message: `no fixture for ${method} ${path}` } } });
    return new Response(JSON.stringify(structuredClone(r.body)), { status: r.status, headers: { "content-type": "application/json" } });
  }));
}

const show = (r: Resume) => render(<ToastProvider><ResumeDetail id={r.id} /></ToastProvider>);
const shown = (r: Resume) => { show(r); return screen.findByRole("heading", { level: 1, name: r.name }); };
const summary = () => screen.getByRole("textbox", { name: "Summary" });          // the Summary section is labelled "Summary" too
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const dialog = (name: string) => screen.findByRole("dialog", { name });

beforeEach(() => { sent.length = 0; clearApiCache(); localStorage.clear(); sessionStorage.clear(); window.location.hash = "#/resumes/1"; });
afterEach(() => { vi.unstubAllGlobals(); setNavGuard(null); });

describe("Resume detail page (real API responses)", () => {
  it("shows the resume the API returned: name, status, file details and the organised content as editable fields", async () => {
    serve(fx.ready);
    await shown(fx.ready);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^${fx.ready.original_filename} · 1 page · read as Text · added`))).toBeInTheDocument();
    expect(screen.getByText(/Organised by AI from your PDF – please check it/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme Corp")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Senior Backend Engineer")).toBeInTheDocument();
    expect(summary()).toHaveValue(ORIGINAL);
    expect(screen.getByText(/^All changes saved/)).toBeInTheDocument();
    expect(button("Save changes")).toBeDisabled();                                  // nothing changed yet
    expect(button(/Practice with this resume/)).toBeEnabled();
    expect(screen.getByRole("link", { name: /Download original/ })).toHaveAttribute("href", `/api/resumes/${fx.ready.id}/file?download=1`);
    expect(screen.getByRole("link", { name: "← Resumes" })).toHaveAttribute("href", "#/resumes");
  });

  it("shows a loading state until the resume arrives", async () => {
    let answer!: (r: Reply) => void;
    serve(fx.ready, { [`GET /api/resumes/${fx.ready.id}`]: new Promise<Reply>((res) => { answer = res; }) });
    show(fx.ready);
    expect(screen.getByText("Loading the resume…")).toBeInTheDocument();
    expect(screen.getByText("Loading the resume…").closest("[aria-busy='true']")).not.toBeNull();
    await act(async () => { answer(ok(fx.ready)); });
    expect(await screen.findByRole("heading", { level: 1, name: fx.ready.name })).toBeInTheDocument();
    expect(screen.queryByText("Loading the resume…")).toBeNull();
  });

  it("reports a failed load with the server's message, a way back, and Try again that loads it", async () => {
    serve(fx.ready, { "GET /api/resumes/1": { status: 404, body: api.not_found } });
    show(fx.ready);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(api.not_found.error.message);
    expect(screen.getByRole("link", { name: "← Resumes" })).toHaveAttribute("href", "#/resumes");
    routes["GET /api/resumes/1"] = ok(fx.ready);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: fx.ready.name })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an edit is marked unsaved, can be discarded, and Save sends it with the revision", async () => {
    serve(fx.ready, { "PATCH /api/resumes/1": ok(fx.saved) });
    await shown(fx.ready);
    fireEvent.change(summary(), { target: { value: EDITED } });
    expect(screen.getByText("Unsaved changes in Summary")).toBeInTheDocument();
    expect(button(/Practice with this resume/)).toBeDisabled();                    // practice uses the saved version: save first
    fireEvent.click(button("Discard"));
    expect(summary()).toHaveValue(ORIGINAL);
    expect(button("Save changes")).toBeDisabled();

    fireEvent.change(summary(), { target: { value: EDITED } });
    fireEvent.click(button("Save changes"));
    expect(await screen.findByText(/^All changes saved/)).toBeInTheDocument();
    expect(await screen.findByText("Saved")).toBeInTheDocument();                  // toast
    const [patch] = writes("PATCH");
    expect(patch.path).toBe("/api/resumes/1");
    expect(patch.body).toMatchObject({ revision: fx.ready.revision, profile: { summary: EDITED } });
    expect(patch.body).not.toHaveProperty("name");
    expect(summary()).toHaveValue(EDITED);
    expect(button(/Practice with this resume/)).toBeEnabled();
  });

  it("a save refused because another tab changed the resume says so and keeps the edit", async () => {
    serve(fx.ready, { "PATCH /api/resumes/1": { status: 409, body: api.stale } });
    await shown(fx.ready);
    fireEvent.change(summary(), { target: { value: EDITED } });
    fireEvent.click(button("Save changes"));
    expect(await screen.findByText(/This resume was changed in another tab\. Reload the page/)).toBeInTheDocument();
    expect(summary()).toHaveValue(EDITED);
    expect(screen.getByText("Unsaved changes in Summary")).toBeInTheDocument();
  });

  it("holds back leaving the page while there are unsaved changes", async () => {
    serve(fx.ready);
    await shown(fx.ready);
    expect(mayNavigate("#/questions")).toBe(true);                                 // nothing changed: free to go
    fireEvent.change(summary(), { target: { value: EDITED } });
    let allowed = true;
    act(() => { allowed = mayNavigate("#/questions"); });
    expect(allowed).toBe(false);
    const leave = await dialog("Leave without saving?");
    fireEvent.click(within(leave).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.hash).toBe("#/resumes/1");
    expect(summary()).toHaveValue(EDITED);

    act(() => { mayNavigate("#/questions"); });
    fireEvent.click(within(await dialog("Leave without saving?")).getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(window.location.hash).toBe("#/questions"));
  });

  it("renames the resume", async () => {
    serve(fx.saved, { "PATCH /api/resumes/1": ok(fx.renamed) });
    await shown(fx.saved);
    fireEvent.click(button("Rename this resume"));
    const input = screen.getByLabelText("Resume name");
    expect(input).toHaveValue(fx.saved.name);
    fireEvent.change(input, { target: { value: `  ${fx.renamed.name} ` } });
    fireEvent.click(button("Save name"));
    expect(await screen.findByRole("heading", { level: 1, name: fx.renamed.name })).toBeInTheDocument();
    expect(writes("PATCH").map((p) => p.body)).toEqual([{ revision: fx.saved.revision, name: fx.renamed.name }]);   // trimmed, name only
    expect(screen.queryByLabelText("Resume name")).toBeNull();
  });

  it("Delete asks first; Cancel keeps it, Delete removes it and goes back to Resumes", async () => {
    serve(fx.failed, { [`DELETE /api/resumes/${fx.failed.id}`]: ok(api.deleted) });
    await shown(fx.failed);
    fireEvent.click(button("Delete"));
    let ask = await dialog(`Delete ${fx.failed.name}?`);
    expect(ask).toHaveTextContent(DELETE_NOTE);
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes("DELETE")).toHaveLength(0);

    fireEvent.click(button("Delete"));
    ask = await dialog(`Delete ${fx.failed.name}?`);
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(window.location.hash).toBe("#/resumes"));
    expect(writes("DELETE").map((d) => d.path)).toEqual([`/api/resumes/${fx.failed.id}`]);
    expect(await screen.findByText(`Deleted ${fx.failed.name}`)).toBeInTheDocument();
  });

  it("Re-organise with AI asks first, shows progress while the resume is read again, then the new content", async () => {
    serve(fx.renamed, { "POST /api/resumes/1/reparse": ok(fx.reparsing) });
    await shown(fx.renamed);
    expect(summary()).toHaveValue(EDITED);
    fireEvent.click(button(/Re-organise with AI/));
    fireEvent.click(within(await dialog("Re-organise with AI?")).getByRole("button", { name: "Re-organise" }));
    expect(await screen.findByText("Reading text…")).toBeInTheDocument();
    expect(button("Stop")).toBeInTheDocument();
    expect(button(/Re-organise with AI/)).toBeDisabled();                          // one job at a time
    expect(writes("POST").map((p) => p.path)).toEqual(["/api/resumes/1/reparse"]);

    routes["GET /api/resumes/1"] = ok(fx.reparsed);                                // the page polls until the backend is done
    await waitFor(() => expect(screen.queryByText("Reading text…")).toBeNull());
    await waitFor(() => expect(summary()).toHaveValue(ORIGINAL));                  // the AI's fresh version replaces the old one
    expect(button(/Re-organise with AI/)).toBeEnabled();
  });

  it("a resume the AI could not organise asks for attention and can be filled in by hand or tried again", async () => {
    serve(fx.failed, { [`POST /api/resumes/${fx.failed.id}/reparse`]: ok(fx.reparsing) });
    await shown(fx.failed);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    const attn = screen.getByRole("alert");
    expect(within(attn).getByRole("heading", { name: "This resume needs your attention" })).toBeInTheDocument();
    expect(attn).toHaveTextContent(fx.failed.error_message as string);
    expect(attn).toHaveTextContent("the PDF and the text that was read are kept");
    expect(button(/Practice with this resume/)).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Summary" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Candidate profile" }));
    expect(screen.getByText(/The candidate profile appears once the resume has been read and organised/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Content" }));

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /Fill in manually/ }));   // the card was re-rendered
    expect(screen.getByText(/Filling in by hand/)).toBeInTheDocument();
    expect(summary()).toHaveValue("");

    fireEvent.click(button("Discard"));                                            // back to the failed card
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(writes("POST").map((p) => p.path)).toEqual([`/api/resumes/${fx.failed.id}/reparse`]));
  });

  it("Practice opens the interview setup with this resume chosen", async () => {
    serve(fx.ready);
    await shown(fx.ready);
    fireEvent.click(button(/Practice with this resume/));
    expect(window.location.hash).toBe("#/setup");
    expect(takeIntent(["resume-practice"])).toEqual({ type: "resume-practice", resumeIds: [fx.ready.id] });
  });

  it("the Candidate profile tab shows what the backend derived, and waits while there are unsaved edits", async () => {
    serve(fx.ready);
    await shown(fx.ready);
    fireEvent.change(summary(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("tab", { name: "Candidate profile" }));
    expect(screen.getByText(/You have unsaved changes\. Save them in the Content tab/)).toBeInTheDocument();
    fireEvent.click(button("Back to Content"));
    expect(screen.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(button("Discard"));

    fireEvent.click(screen.getByRole("tab", { name: "Candidate profile" }));
    expect(await screen.findByRole("heading", { name: "Skills" })).toBeInTheDocument();
    const high = api.intelligence.skills.filter((s) => s.confidence === "high");
    expect(button(/High confidence/)).toHaveTextContent(String(high.length));
    for (const s of high) expect(screen.getByText(s.name)).toBeVisible();
    const quality = screen.getByRole("region", { name: "Extraction quality" });
    expect(quality).toHaveTextContent(`${api.intelligence.extraction.confidence} confidence`);
  });

  it("the Preview tab shows the original PDF and the Original text tab the text read from it", async () => {
    serve(fx.ready);
    await shown(fx.ready);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle(`${fx.ready.name} (original PDF)`)).toHaveAttribute("src", "/api/resumes/1/file");
    expect(screen.getByRole("link", { name: /Open in new tab/ })).toHaveAttribute("href", "/api/resumes/1/file");
    expect(screen.getByRole("link", { name: /^Download$/ })).toHaveAttribute("href", "/api/resumes/1/file?download=1");

    fireEvent.click(screen.getByRole("tab", { name: "Original text" }));
    const raw = await screen.findByLabelText("Original text");
    expect(raw).toHaveTextContent("Cut p95 API latency by 40%");
    expect(within(raw).getByText("page 1")).toHaveClass("rz-page");               // "--- page 1 ---" becomes a page marker
    expect(screen.getByText("Text read from your PDF")).toBeInTheDocument();
    expect(writes("POST")).toHaveLength(0);
  });
});
