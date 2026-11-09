// A stand-in for Ollama cloud's documented API (Bearer key, GET /api/tags, streaming POST /api/chat) so the whole cloud experience can be
// tested in a real browser WITHOUT any network or credits. It records every request so tests can prove what was sent and how many calls were made.
import { createServer } from "node:http";

export const CLOUD_MODELS = ["gpt-oss:120b", "deepseek-v4.1-flash", "gemma4:31b", "gemma4:12b", "kimi-k3"];

const evaluation = (answer) => ({
  question_level: "standard", correct_points: ["Explained the core idea"], missing_concepts: /partial/i.test(answer) ? ["Merge keys"] : [], misconceptions: [],
  dimension_scores: { correctness: 7, completeness: 7, depth: 6, practical_application: 6, clarity: 8, production_awareness: 5 }, production_relevant: false,
  verdict_summary: "A solid answer from the cloud grader.", suggested_improvements: ["Add an example"], ideal_answer: "A concise reference answer.", confidence: "high",
  uncertainty_note: "", needs_followup: /partial/i.test(answer), followup_question: /partial/i.test(answer) ? "Draft: which keys would you use?" : "", followup_reason: "A key concept was missing.",
});

export async function startFakeCloud({ key = "good-key-0123456789", port = 0 } = {}) {
  const state = { key, models: [...CLOUD_MODELS], tags: 0, chats: [], failNext: [], authFailures: 0, tinyTokens: [30, 10], gradeTokens: [1200, 400], followTokens: [400, 80] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/__stats") return send(200, { tags: state.tags, chats: state.chats, authFailures: state.authFailures });
      if (url.pathname === "/__control") { Object.assign(state, JSON.parse(raw || "{}")); return send(200, { ok: true }); }
      if ((req.headers.authorization || "") !== `Bearer ${state.key}`) { state.authFailures++; return send(401, { error: "unauthorized" }); }
      if (url.pathname === "/api/tags" && req.method === "GET") { state.tags++; return send(200, { models: state.models.map((m) => ({ name: m, model: m })) }); }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const body = JSON.parse(raw);
        const system = body.messages?.[0]?.content ?? "";
        const user = body.messages?.[body.messages.length - 1]?.content ?? "";
        const kind = /evaluating ONE candidate answer/.test(system) ? "evaluation" : /repair speech-recognition/.test(system) ? "repair" : /Write ONE short follow-up/.test(system) ? "followup"
          : /closing assessment/.test(system) ? "summary" : body.stream === false ? "test" : "other";
        state.chats.push({ kind, model: body.model, stream: body.stream, hasFormat: "format" in body, think: body.think, numPredict: body.options?.num_predict, schemaInPrompt: /OUTPUT FORMAT/.test(system), user: user.slice(0, 400) });
        if (state.failNext.length) { const code = state.failNext.shift(); return send(code, { error: `simulated ${code}` }); }
        const answer = (user.match(/<<<CANDIDATE_ANSWER\n([\s\S]*?)\nCANDIDATE_ANSWER>>>/) || [, ""])[1];
        const payload = kind === "evaluation" ? evaluation(answer)
          : kind === "followup" ? { question: "How would you choose a merge key when some records arrive late?" }
          : kind === "repair" ? { text: answer || "ok", unclear: [] }
          : kind === "summary" ? { overall_summary: "A solid cloud-graded session.", strengths: ["Clear explanations"], knowledge_gaps: [], repeated_misconceptions: [], topics_to_revise: [], recommendations: ["Keep practicing"] }
          : { ok: true };
        const text = kind === "test" ? "ok" : JSON.stringify(payload);
        const [pt, ot] = kind === "test" ? state.tinyTokens : kind === "followup" ? state.followTokens : state.gradeTokens;
        const metrics = { prompt_eval_count: pt, eval_count: ot, load_duration: 0, prompt_eval_duration: 300e6, eval_duration: 4e9, total_duration: 4.4e9 };
        if (body.stream === false) return send(200, { message: { role: "assistant", content: text }, done: true, ...metrics });
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { role: "assistant", thinking: "(reasoning)", content: "" }, done: false }) + "\n");
        res.write(JSON.stringify({ message: { role: "assistant", content: text.slice(0, 20) }, done: false }) + "\n");
        res.end(JSON.stringify({ message: { role: "assistant", content: text.slice(20) }, done: true, ...metrics }) + "\n");
        return;
      }
      send(404, { error: "unknown" });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  return {
    url: base, key,
    stats: () => get("/__stats"),
    control: (patch) => fetch(base + "/__control", { method: "POST", body: JSON.stringify(patch) }),
    stop: () => new Promise((r) => server.close(r)),
  };
}
