// A stand-in for treg (https://treg.to/call/...) at the one faked seam: the
// test server's TREG_BASE_URL points here, so no test can reach the real
// treg, Instagram or any provider. It answers the Instagram Graph calls the
// publish flow makes through the team's own tool, records every call, and
// answers 404 to anything else (scans, metrics), which those paths treat as
// a failed read. Tests steer it through /__fake/*.
//
// It also stands in for the Claude endpoint (ANTHROPIC_BASE_URL points here
// too, with an OpenRouter-style ANTHROPIC_AUTH_TOKEN): POST /v1/messages
// records the auth headers and answers a fixed adaptation, so the auth path
// is tested with no network call and nothing billed.
import http from "node:http";

export const FAKE_PORT = Number(process.env.FAKE_TREG_PORT ?? 3991);
export const FAKE_BASE = `http://localhost:${FAKE_PORT}`;
export const FAKE_TOKEN = "fake-treg-token";

let calls = [];
let mode = "ok"; // ok | error (container ERROR) | stuck (never FINISHED) | nolink (publish ok, no permalink) | wrongaccount
let n = 0;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startFakeTreg() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, FAKE_BASE);
    let raw = "";
    for await (const c of req) raw += c;
    if (url.pathname === "/__fake/calls") return send(res, 200, calls);
    if (url.pathname === "/v1/messages") {
      calls.push({
        method: req.method,
        path: "claude:/v1/messages",
        auth: req.headers.authorization ?? null,
        xApiKey: req.headers["x-api-key"] ?? null,
        body: raw ? JSON.parse(raw) : null,
      });
      const adaptation = {
        analysis: { hook: "h", reframe: "r", mechanism: "m", philosophical_close: "p", cta: "c", top_psychological_triggers: [] },
        adapted_script: "Faked adaptation.",
        red_line_flag: "none",
        red_line_reason: "",
        edits_made: [],
      };
      return send(res, 200, {
        id: "msg_fake", type: "message", role: "assistant", model: "fake",
        content: [{ type: "text", text: JSON.stringify(adaptation) }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (url.pathname === "/__fake/reset") {
      calls = [];
      mode = JSON.parse(raw || "{}").mode ?? "ok";
      return send(res, 200, { mode });
    }
    if (req.headers["x-treg-token"] !== FAKE_TOKEN) return send(res, 401, { detail: "bad token" });

    const path = url.pathname.replace(/^\/call\//, "");
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

    const graph = path.match(/^instagram-2\/(.+)$/);
    if (!graph) return send(res, 404, { detail: "not faked" });
    const [, rest] = graph;
    if (req.method === "GET" && rest === "me") return send(res, 200, { username: mode === "wrongaccount" ? "thecyrusamin" : "surahwise", id: "1" });
    if (req.method === "POST" && rest === "me/media") return send(res, 200, { id: `c${++n}` });
    if (req.method === "POST" && rest === "me/media_publish") return send(res, 200, { id: `m${++n}` });
    if (req.method === "GET" && /^c\d+$/.test(rest)) {
      const status_code = mode === "error" ? "ERROR" : mode === "stuck" ? "IN_PROGRESS" : "FINISHED";
      return send(res, 200, { status_code, status: mode === "error" ? "video too long" : undefined });
    }
    if (req.method === "GET" && /^m\d+$/.test(rest)) {
      return send(res, 200, mode === "nolink" ? {} : { permalink: `https://www.instagram.com/reel/FAKE${rest}/` });
    }
    return send(res, 404, { detail: "not faked" });
  });
  return new Promise((resolve) => server.listen(FAKE_PORT, () => resolve(server)));
}
