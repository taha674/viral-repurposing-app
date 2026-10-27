// A stand-in for treg (https://treg.to/call/...) at the one faked seam: the
// test server's TREG_BASE_URL points here, so no test can reach the real
// treg, Instagram or any provider. It answers the Instagram Graph calls the
// publish flow makes through the team's own tool, records every call, and
// answers 404 to anything else (metrics), which those paths treat as a failed
// read. Scans find nothing, except the carousel feeds below. Tests steer it through /__fake/*.
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const img = (n) => `${FAKE_BASE}/__fake/img/${n}.png`;

// The carousel feeds the scan reads (tikhub), as the real provider shapes them.
// Hashtag feed: slides under `resources`, caption as `caption_text`. A reel
// rides along and must be ignored by the carousel pass.
const hashtagFeed = [
  { code: "CARA", media_type: 8, product_type: "carousel_container", like_count: 600, caption_text: "Hifz tip: revise before you add new pages #hifz", user: { username: "tipper" },
    resources: [1, 2, 3].map((i) => ({ media_type: 1, video_versions: [], image_versions: [{ url: img(`a${i}`) }] })) },
  { code: "CARB", media_type: 8, product_type: "carousel_container", like_count: 100, caption_text: "Few likes",
    resources: [{ media_type: 1, image_versions: [{ url: img("b1") }] }] },
  { code: "CARC", media_type: 8, product_type: "carousel_container", like_count: 900, caption_text: "OFFTOPIC course announcement",
    resources: [{ media_type: 1, image_versions: [{ url: img("c1") }] }] },
  { code: "REELX", media_type: 2, product_type: "clips", play_count: 99999, like_count: 5000, caption_text: "a reel" },
];
// Account feed: slides under `carousel_media` with {items: [...]} renditions,
// caption as {text}. The second slide is a video and is dropped.
const accountFeed = [
  { code: "CARE", media_type: 8, product_type: "carousel_container", like_count: 700, caption: { text: "Account tip #hifdh" }, user: { username: "acct" },
    carousel_media: [
      { media_type: 1, image_versions: { items: [{ url: img("e1") }] } },
      { media_type: 2, video_versions: [{ url: "x" }], image_versions: { items: [{ url: img("e2") }] } },
    ] },
];

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
      const schema = calls[calls.length - 1].body?.output_config?.format?.schema;
      if (schema?.properties?.matches && schema?.properties?.text) {
        // Carousel reading: an OFFTOPIC caption is not hifz; anything else is,
        // with one line of slide text per image sent.
        const content = calls[calls.length - 1].body.messages[0].content;
        const images = content.filter((b) => b.type === "image").length;
        const off = content.some((b) => b.type === "text" && b.text.includes("OFFTOPIC"));
        const reading = off
          ? { matches: false, reason: "a course announcement", text: "" }
          : { matches: true, reason: "a revision tip", text: Array.from({ length: images }, (_, i) => `${i + 1}. Slide ${i + 1} text`).join("\n") };
        return send(res, 200, {
          id: "msg_fake", type: "message", role: "assistant", model: "fake",
          content: [{ type: "text", text: JSON.stringify(reading) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
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
    if (url.pathname.startsWith("/__fake/img/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (req.headers["x-treg-token"] !== FAKE_TOKEN) return send(res, 401, { detail: "bad token" });

    const path = url.pathname.replace(/^\/call\//, "");
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

    // Scans find no reels; the carousel feeds answer.
    if (path === "treg.instagram.hashtag.posts") return send(res, 200, { output: { posts: [] }, _treg: { served_by: "fake", tried: [] } });
    if (path === "treg.instagram.user.reels") return send(res, 200, { output: { reels: [] }, _treg: { served_by: "fake", tried: [] } });
    if (path === "tikhub.x.instagram-v2-fetch-hashtag-posts") return send(res, 200, { data: { data: { items: hashtagFeed } } });
    if (path === "tikhub.x.instagram-v2-fetch-user-posts") return send(res, 200, { data: { data: { items: accountFeed } } });

    // Routed post detail: the play count only in `raw`, as tikhub answers.
    // The shortcode carries it: V60000 -> 60000 plays.
    // Any other shortcode gets the 404 below, which metrics treats as no answer.
    const detailCode = path === "treg.instagram.post.detail" && String(body?.url).match(/\/reel\/(V\d+)\//)?.[1];
    if (detailCode) {
      const code = detailCode;
      return send(res, 200, {
        output: { shortcode: code, caption: "fake caption" },
        raw: { data: { shortcode: code, video_play_count: Number(code.slice(1)) } },
        _treg: { served_by: "fake", tried: [] },
      });
    }

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
