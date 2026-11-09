import { describe, expect, it } from "vitest";
import { resumePaletteItems } from "../palette";
import type { Intent } from "../intent";
import {
  anyWorking, changedSections, checkPdf, claimChip, clampCount, emptyProfile, generationCost, generationMinutes, generationRequests, interviewMinutes, isWorking,
  looksLikePdf, methodLabel, mixSequence, move, nextResumeName, normalise, removeAt, sameProfile, sessionCounts, stageText, statusChip, steps, toInput,
  topSkills, validateProfile, validQuestion,
} from "../resumeHelpers";
import type { AIConfig, DraftQuestion, ResumeProfile, ResumeSummary } from "../types";

const r = (over: Partial<ResumeSummary>): ResumeSummary => ({
  id: 1, name: "Resume 1", original_filename: "cv.pdf", size_bytes: 1000, pages: 1, status: "ready", stage_detail: null, error_code: null, error_message: null,
  extraction_method: "text", consent_cloud: null, revision: 1, created_at: "", updated_at: "", last_parsed_at: null, has_profile: true, skills_preview: [], warnings: 0, ...over,
});
const profile = (): ResumeProfile => ({ ...emptyProfile(), contact: { name: "Jane", email: "", phone: "", location: "", links: [] },
  skills: [{ group: "Languages", items: ["Python", "Go"] }, { group: "Cloud", items: ["AWS", "Go"] }],
  experience: [{ company: "Acme", title: "Engineer", location: "", start: "2021", end: "", is_current: true, bullets: ["Cut latency by 40%"] }] });

describe("default naming", () => {
  it("uses the lowest free number", () => {
    expect(nextResumeName([])).toBe("Resume 1");
    expect(nextResumeName(["Resume 1", "Resume 3", "My CV"])).toBe("Resume 2");
    expect(nextResumeName(["Resume 1", "Resume 2"])).toBe("Resume 3");
    expect(nextResumeName(["resume 1", "Resume 1x"])).toBe("Resume 1");
  });
});

describe("status and stage labels", () => {
  it("maps statuses to the four chips (plus the cloud question)", () => {
    expect(statusChip(r({ status: "extracting" })).label).toBe("Reading…");
    expect(statusChip(r({ status: "ocr" })).label).toBe("Reading…");
    expect(statusChip(r({ status: "structuring" })).label).toBe("Organising…");
    expect(statusChip(r({ status: "ready" }))).toEqual({ label: "Ready", tone: "ok" });
    expect(statusChip(r({ status: "failed" }))).toEqual({ label: "Needs attention", tone: "bad" });
    expect(statusChip(r({ status: "uploaded", stage_detail: "awaiting_cloud_consent" })).label).toBe("Waiting for your OK");
  });
  it("describes the current step in plain words", () => {
    expect(stageText(r({ status: "extracting", stage_detail: "page 2 of 3" }))).toBe("Reading text · page 2 of 3");
    expect(stageText(r({ status: "ocr", stage_detail: "page 1 of 2" }))).toBe("Running OCR · page 1 of 2");
    expect(stageText(r({ status: "structuring", stage_detail: "part 1 of 3" }))).toBe("Organising with AI · part 1 of 3");
    expect(stageText(r({ status: "uploaded", stage_detail: "queued" }))).toBe("Waiting to start…");
    expect(methodLabel("mixed")).toBe("Mixed");
    expect(methodLabel(null)).toBeNull();
  });
  it("knows when to keep polling", () => {
    expect(isWorking(r({ status: "structuring" }))).toBe(true);
    expect(isWorking(r({ status: "uploaded", stage_detail: "queued" }))).toBe(true);
    expect(isWorking(r({ status: "uploaded", stage_detail: "awaiting_cloud_consent" }))).toBe(false);
    expect(anyWorking([r({}), r({ status: "failed" })])).toBe(false);
    expect(anyWorking([r({}), r({ status: "ocr" })])).toBe(true);
  });
  it("builds the stepper, showing OCR only when it is needed", () => {
    expect(steps(null, true).map((s) => [s.key, s.state])).toEqual([["upload", "active"], ["read", "todo"], ["organise", "todo"], ["ready", "todo"]]);
    const ocr = steps(r({ status: "ocr", stage_detail: "page 2 of 3", extraction_method: null }));
    expect(ocr.map((s) => s.key)).toEqual(["upload", "read", "ocr", "organise", "ready"]);
    expect(ocr.find((s) => s.key === "ocr")).toMatchObject({ state: "active", detail: "page 2 of 3" });
    expect(steps(r({ status: "ready" })).every((s) => s.state === "done")).toBe(true);
    expect(steps(r({ status: "failed", error_code: "structure_failed" })).find((s) => s.key === "organise")?.state).toBe("error");
    expect(steps(r({ status: "failed", error_code: "ocr_unavailable", extraction_method: "text" })).find((s) => s.key === "ocr")?.state).toBe("error");
  });
});

describe("client-side file checks mirror the server", () => {
  it("accepts PDFs within the limit only", () => {
    expect(checkPdf({ name: "cv.pdf", type: "application/pdf", size: 1000 }, 10)).toBeNull();
    expect(checkPdf({ name: "CV.PDF", type: "", size: 1000 }, 10)).toBeNull();
    expect(checkPdf({ name: "cv.docx", type: "application/msword", size: 1000 }, 10)).toMatch(/Only PDF/);
    expect(checkPdf({ name: "cv.pdf", type: "application/pdf", size: 0 }, 10)).toMatch(/empty/);
    expect(checkPdf({ name: "cv.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }, 10)).toMatch(/larger than 10 MB/);
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("PK\u0003\u0004"))).toBe(false);
  });
});

describe("dirty-diff and validation of the editor", () => {
  it("ignores whitespace and blank items, notices real changes", () => {
    const a = profile();
    const b = structuredClone(a);
    b.contact.name = "  Jane ";
    b.experience[0].bullets.push("   ");
    expect(sameProfile(a, b)).toBe(true);
    b.experience[0].bullets[0] = "Cut latency by 45%";
    expect(sameProfile(a, b)).toBe(false);
    expect(changedSections(a, b)).toEqual(["Experience"]);
    b.summary = "New";
    expect(changedSections(a, b)).toEqual(["Summary", "Experience"]);
    expect(normalise(b).experience[0].bullets).toEqual(["Cut latency by 45%"]);
  });
  it("reports exactly which field is too long or which list is too big", () => {
    const p = profile();
    expect(validateProfile(p)).toEqual([]);
    p.summary = "x".repeat(3001);
    p.experience[0].bullets = ["y".repeat(801)];
    p.skills = Array.from({ length: 21 }, () => ({ group: "g", items: [] }));
    const errs = validateProfile(p).map((e) => e.path);
    expect(errs).toEqual(expect.arrayContaining(["summary", "experience.0.bullets.0", "skills"]));
  });
  it("moves and removes list items", () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(removeAt([1, 2, 3], 1)).toEqual([1, 3]);
    expect(topSkills(profile(), 3)).toEqual(["Python", "Go", "AWS"]);
  });
});

describe("questions, mixing and the session summary", () => {
  const q: DraftQuestion = { text: " How did you cut latency at Acme? ", rubric: "", topic: "Backend", difficulty: "medium", kind: "metric_challenge", resume_id: 3, resume_name: "Resume 1",
    claim: { section: "Experience", label: "Engineer at Acme", excerpt: "Cut latency by 40%" } };
  it("names where a question came from", () => {
    expect(claimChip(q)).toBe("From: Resume 1 › Experience › Engineer at Acme");
    expect(claimChip(q, true)).toBe("From: Resume 1 (deleted resume) › Experience › Engineer at Acme");
  });
  it("turns a draft into what the server accepts", () => {
    expect(toInput(q)).toMatchObject({ text: "How did you cut latency at Acme?", rubric: null, resume_id: 3, claim: q.claim });
    expect(validQuestion(q)).toBe(true);
    expect(validQuestion({ ...q, text: "  " })).toBe(false);
    expect(validQuestion({ ...q, text: "x".repeat(1001) })).toBe(false);
  });
  it("orders bank and resume questions like the server, interleave appending the remainder", () => {
    expect(mixSequence("bank_first", 2, 1)).toEqual(["B", "B", "R"]);
    expect(mixSequence("resume_first", 2, 1)).toEqual(["R", "B", "B"]);
    expect(mixSequence("interleave", 3, 2)).toEqual(["R", "B", "R", "B", "B"]);
    expect(mixSequence("interleave", 1, 3)).toEqual(["R", "B", "R", "R"]);
  });
  it("counts per source and estimates time", () => {
    expect(sessionCounts("bank", 5, 8)).toEqual({ bank: 5, resume: 0, total: 5 });
    expect(sessionCounts("resume", 5, 8)).toEqual({ bank: 0, resume: 8, total: 8 });
    expect(sessionCounts("both", 5, 8)).toEqual({ bank: 5, resume: 8, total: 13 });
    expect(interviewMinutes(4, 2)).toBe(20);
    expect(interviewMinutes(1, 0)).toBe(5);
    expect(clampCount(25)).toBe(20);
    expect(clampCount(1)).toBe(3);
    expect(clampCount(NaN)).toBe(8);
    expect(generationRequests(8, "overview")).toBe(3);
    expect(generationRequests(9, "deep")).toBe(2);
    expect(generationMinutes(8, "standard", false)).toBeGreaterThanOrEqual(1);
    const cfg = { grader_model: "gpt-oss:120b", prices: { "gpt-oss:120b": { input_per_m: 0.15, output_per_m: 0.6, offpeak_input_per_m: null, offpeak_output_per_m: null } } } as unknown as AIConfig;
    expect(generationCost(cfg, 8, "overview")).toBeCloseTo((3 * (1600 * 0.15 + 1100 * 0.6)) / 1e6, 10);
    expect(generationCost({ ...cfg, grader_model: "unknown" }, 8, "overview")).toBeNull();
  });
});

describe("palette entries for resumes", () => {
  it("offers upload, interview-from-resume and the Resumes page", () => {
    const went: string[] = [], intents: Intent[] = [];
    const items = resumePaletteItems((h) => went.push(h), (i) => intents.push(i), [7, 9]);
    expect(items.map((i) => [i.id, i.group, i.label])).toEqual([
      ["resume-upload", "Actions", "Upload resume"], ["resume-interview", "Actions", "Interview from my resume"], ["go-resumes", "Go to", "Resumes"]]);
    items[0].run(); items[1].run(); items[2].run();
    expect(went).toEqual(["#/resumes", "#/setup", "#/resumes"]);
    expect(intents).toEqual([{ type: "resume-upload" }, { type: "resume-practice", resumeIds: [7] }]);
    expect(items[2].hint).toBe("G E");
  });
  it("sends you to upload one when none is ready", () => {
    const went: string[] = [], intents: Intent[] = [];
    resumePaletteItems((h) => went.push(h), (i) => intents.push(i), [])[1].run();
    expect(went).toEqual(["#/resumes"]);
    expect(intents).toEqual([{ type: "resume-upload" }]);
  });
});
