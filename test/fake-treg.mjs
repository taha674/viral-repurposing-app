// A stand-in for treg (https://treg.to/call/...) at the one faked seam: the
// test server's TREG_BASE_URL points here, so no test can reach the real
// treg, Instagram or any provider. It answers the Instagram Graph calls the
// publish flow makes through the team's own tool, records every call, and
// answers 404 to anything else (scans, metrics), which those paths treat as
// a failed read. Tests steer it through /__fake/*.
import http from "node:http";

export const FAKE_PORT = Number(process.env.FAKE_TREG_PORT ?? 3991);
export const FAKE_BASE = `http://localhost:${FAKE_PORT}`;
export const FAKE_TOKEN = "fake-treg-token";

let calls = [];
let mode = "ok"; // ok | error (container ERROR) | stuck (never FINISHED) | nolink (publish ok, no permalink)
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
    if (url.pathname === "/__fake/reset") {
      calls = [];
      mode = JSON.parse(raw || "{}").mode ?? "ok";
      return send(res, 200, { mode });
    }
    if (req.headers["x-treg-token"] !== FAKE_TOKEN) return send(res, 401, { detail: "bad token" });

    const path = url.pathname.replace(/^\/call\//, "");
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

    const graph = path.match(/^instagram\/v[\d.]+\/(.+)$/);
    if (!graph) return send(res, 404, { detail: "not faked" });
    const [, rest] = graph;
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
