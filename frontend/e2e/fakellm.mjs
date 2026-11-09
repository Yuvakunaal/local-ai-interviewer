// A stand-in for the LOCAL Ollama that also answers /api/chat, so resume reading, question writing, grading and the report summary can be
// driven end to end in real Chrome without a model. It answers by the JSON schema each request carries, exactly like the real server would
// be constrained to. Loopback only; nothing leaves this computer.
import { createServer } from "node:http";

const PROFILE = {
  contact: { name: "Jane Doe", email: "jane.doe@example.com", phone: "+1 555 0100", location: "Berlin", links: [] },
  summary: "Backend engineer with 6 years of experience building data platforms.",
  skills: [{ group: "Languages", items: ["Python", "Go", "SQL"] }, { group: "Cloud", items: ["AWS", "Kubernetes", "Terraform"] }],
  experience: [
    { company: "Acme Corp", title: "Senior Backend Engineer", location: "Berlin", start: "Mar 2021", end: "Present", is_current: true,
      bullets: ["Cut p95 API latency by 40% by moving hot reads to Redis", "Led the migration of 30 services from a monolith to Kubernetes", "Mentored 4 engineers and ran the on-call rotation"] },
    { company: "Globex", title: "Software Engineer", location: "Munich", start: "Jan 2018", end: "Jun 2020", is_current: false,
      bullets: ["Built a Kafka pipeline processing 2M events per day", "Wrote the billing reconciliation service in Go"] },
  ],
  projects: [{ name: "Open-source rate limiter", role: "", tech: ["Go", "Redis"], link: "", bullets: ["Token bucket library with 1.2k GitHub stars"] }],
  education: [{ school: "TU Munich", degree: "MSc", field: "Computer Science", start: "2016", end: "2018", details: "" }],
  certifications: [], achievements: [], other: [],
};
const PROFILE2 = { ...PROFILE, contact: { ...PROFILE.contact, name: "Jane D." }, summary: "",
  skills: [{ group: "Skills", items: ["Python", "Kafka", "PostgreSQL"] }],
  experience: [{ company: "Initech", title: "Data Engineer", location: "", start: "2019", end: "Present", is_current: true, bullets: ["Reduced warehouse cost by 25% with partition pruning", "Designed CDC ingestion for 120 tables"] }],
  projects: [], education: [{ school: "MIT", degree: "BSc", field: "Physics", start: "", end: "2015", details: "" }] };
const ANGLE = { project_deep_dive: "Walk me through how you approached", tech_depth: "How deep is your hands-on experience with", metric_challenge: "How exactly did you measure",
  ownership_behavioural: "Tell me about a moment you personally owned", decision_tradeoff: "Which trade-offs did you weigh in", failure_learning: "What went wrong along the way in",
  gap_transition: "What led you to make the change in" };

const evalReply = (score) => ({ question_level: "standard", correct_points: ["Named a concrete decision"], missing_concepts: score < 7 ? ["How the result was measured"] : [], misconceptions: [],
  dimension_scores: { correctness: score, completeness: score, depth: score, practical_application: score, clarity: score, production_awareness: score },
  production_relevant: false, verdict_summary: "A short judgement.", suggested_improvements: score < 7 ? ["Say how you measured the improvement and what the baseline was"] : [],
  ideal_answer: "A concise reference answer.", confidence: "high", uncertainty_note: "", needs_followup: false, followup_question: "", followup_reason: "Covered." });

function answer(body, state) {
  const props = Object.keys(body.format?.properties ?? {});
  const user = body.messages?.[1]?.content ?? "";
  if (props.includes("experience")) { state.parses++; return /Initech/.test(user) ? PROFILE2 : PROFILE; }
  if (props.includes("questions")) {
    state.writes++;
    const qs = [];
    for (const m of user.matchAll(/CLAIM (C\d+) - [^:]+: (.+)\nRequested kinds: (.+)/g)) {
      const kinds = [...m[3].matchAll(/(\w+) \(/g)].map((k) => k[1]);
      for (const k of kinds) qs.push({ claim_ref: m[1], kind: k, text: `${ANGLE[k] ?? "Tell me about"} ${m[2]}, and what was your own part in it?`,
        rubric: "Their own role, a concrete decision and trade-off, how the result was measured, and what they learned.", topic: /Kafka/.test(m[2]) ? "Kafka" : "Backend", difficulty: "medium" });
    }
    return { questions: qs };
  }
  if (props.includes("dimension_scores")) { state.evals++; return evalReply(/latency|Acme/i.test(user) && state.evals % 2 ? 5 : 8); }
  if (props.includes("overall_summary")) return { overall_summary: "Solid practice session.", strengths: ["Concrete examples"], knowledge_gaps: [], repeated_misconceptions: [], topics_to_revise: [], recommendations: ["Keep going"] };
  if (props.includes("question")) return { question: "Could you say more about how you measured it?" };
  if (props.includes("text")) return { text: user.split("<<<TRANSCRIPT\n")[1]?.split("\nTRANSCRIPT>>>")[0] ?? "", unclear: [] };
  return { ok: true };
}

export async function startFakeLlm({ delayMs = 300 } = {}) {
  const state = { parses: 0, writes: 0, evals: 0, chats: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/api/version") return json(200, { version: "0.99.0" });
    if (url.pathname === "/api/tags") return json(200, { models: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 4e9 }] });
    if (url.pathname === "/api/ps") return json(200, { models: [] });
    if (url.pathname === "/api/show") return json(404, { error: "model not found" });
    if (url.pathname === "/api/generate") return json(200, { done: true });
    if (url.pathname === "/api/chat") {
      state.chats++;
      await new Promise((r) => setTimeout(r, delayMs));            // like a (very fast) model: progress is visible for a moment
      const text = JSON.stringify(answer(body, state));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: text.slice(0, 10) }, done: false }) + "\n");
      res.end(JSON.stringify({ message: { content: text.slice(10) }, done: true, prompt_eval_count: 700, eval_count: 300, eval_duration: 9e8, prompt_eval_duration: 1e8, total_duration: 1e9 }) + "\n");
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
