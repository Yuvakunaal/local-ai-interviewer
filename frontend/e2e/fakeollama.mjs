// A tiny stand-in for the LOCAL Ollama (version, tags, ps, pull with progress) so the first-run setup screen can be tested without
// installing, removing or downloading anything on this computer.
import { createServer } from "node:http";

export async function startFakeOllama({ models = [], pullSteps = 6, pullDelayMs = 250 } = {}) {
  const state = { up: true, models: [...models], pulls: [], failNext: null };
  const server = createServer(async (req, res) => {
    if (!state.up) { req.socket.destroy(); return; }
    const url = new URL(req.url, "http://x");
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/version") return json(200, { version: "0.99.0" });
    if (url.pathname === "/api/tags") return json(200, { models: state.models.map((name) => ({ name, model: name, size: 4e9 })) });
    if (url.pathname === "/api/ps") return json(200, { models: [] });
    if (url.pathname === "/api/show") return json(404, { error: "model not found" });
    if (url.pathname === "/api/pull" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const { model } = JSON.parse(body || "{}");
      state.pulls.push(model);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (state.failNext) { res.end(JSON.stringify({ error: state.failNext }) + "\n"); state.failNext = null; return; }
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      for (let i = 1; i <= pullSteps; i++) {
        await new Promise((r) => setTimeout(r, pullDelayMs));
        if (res.destroyed || !state.up) return;
        res.write(JSON.stringify({ status: "pulling 3f2a9c", total: 1000, completed: Math.round((i / pullSteps) * 1000) }) + "\n");
      }
      state.models.push(model);
      res.end(JSON.stringify({ status: "success" }) + "\n");
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, state, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
