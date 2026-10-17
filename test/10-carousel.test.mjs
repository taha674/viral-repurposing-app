// Ticket 10: the carousel track. The slides adaptation is a paid call, so
// its result is seeded; everything around it goes through MCP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, call, original, forceStatus, sql } from "./harness.mjs";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slides-"));
function png(name, color, size = "1080x1350") {
  const f = path.join(tmp, name);
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", "-metadata", "title=SECRET", f], { stdio: "ignore" });
  return f;
}
// The slide's average colour as [r, g, b].
const rgb = (f) => [...execFileSync(FFMPEG, ["-v", "quiet", "-i", f, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];

async function upload(url, files) {
  const form = new FormData();
  for (const f of files) form.append("slides", new Blob([fs.readFileSync(f)]), path.basename(f));
  return fetch(url, { method: "POST", body: form });
}

test("a carousel from an approved reel: slides rail, ordered stripped upload, ready post", async () => {
  const src = await original(mcp, { hook: "C" });
  const early = await call(mcp, "add_carousel", { from_reel_id: src.id, rationale: "t" });
  assert.equal(early.ok, false, "the source script is not approved yet");

  await forceStatus(src.id, "approved", { adapted_script: "Approved reel script about weak pages." });
  const c = (await call(mcp, "add_carousel", { from_reel_id: src.id, brand: "nuronomics", rationale: "derive" })).data;
  assert.equal(c.kind, "carousel");
  assert.equal(c.stage, "script");
  assert.equal(c.hook, "C", "takes the source's hook");
  assert.equal(c.transcript, "Approved reel script about weak pages.");

  // Paid: refused at the cap in tests.
  assert.match((await call(mcp, "adapt_reel", { id: c.id })).error, /cap/);

  const slides = [{ headline: "Stop forgetting", body: "" }, { headline: "Mark weak pages", body: "A dot each stumble." }];
  await forceStatus(c.id, "adapted", {
    slides: JSON.stringify(slides), adapted_script: "1. Stop forgetting\n2. Mark weak pages — A dot each stumble.",
    red_line_flag: "needs_review", red_line_reason: "claim",
  });
  assert.equal((await call(mcp, "approve_script", { id: c.id, rationale: "t" })).ok, false);
  const ok = await call(mcp, "approve_script", { id: c.id, rationale: "t", operator_confirmed: true, confirmation_note: "Taha: ok" });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "slides");
  assert.equal(ok.data.stage, "slides");
  assert.ok(ok.data.allowed_actions.includes("create_slides_upload_link"));

  const { upload_url } = (await call(mcp, "create_slides_upload_link", { id: c.id })).data;
  const bad = await upload(upload_url, [png("a.png", "red"), png("small.png", "blue", "1080x1080")]);
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /1080x1350/);

  const files = [png("1.png", "red"), png("2.png", "lime"), png("3.png", "blue")];
  const up = await upload(upload_url, files);
  assert.equal(up.status, 200, await up.text());

  const done = (await call(mcp, "get_reel", { id: c.id })).data;
  assert.equal(done.status, "captioned");
  assert.equal(done.slide_paths.length, 3);
  assert.deepEqual(done.slide_paths.map((p) => path.basename(p).slice(-12)), ["-slide-01.png", "-slide-02.png", "-slide-03.png"].map((s) => s.slice(-12)));
  const colours = done.slide_paths.map(rgb);
  assert.ok(colours[0][0] > 200 && colours[0][2] < 50, "slide 1 is the red one");
  assert.ok(colours[1][1] > 200, "slide 2 is the green one");
  assert.ok(colours[2][2] > 200 && colours[2][0] < 50, "slide 3 is the blue one");
  for (const p of done.slide_paths) assert.ok(!fs.readFileSync(p).includes(Buffer.from("SECRET")), "metadata stripped");

  await call(mcp, "schedule_item", { id: c.id, planned_post_at: new Date(Date.now() + 3600e3).toISOString(), rationale: "t" });
  const ready = (await call(mcp, "list_ready_posts", {})).data.find((p) => p.id === c.id);
  assert.equal(ready.files.slide_urls.length, 3);
  assert.equal(ready.files.video_url, null);
  const first = await fetch(ready.files.slide_urls[0]);
  assert.equal(first.headers.get("content-type"), "image/png");
});

test("a carousel from an original script; move back from Slides goes to Adaptation", async () => {
  const c = (await call(mcp, "add_carousel", { script: "Three ways to keep your manzil.", brand: "nuronomics", hook: "A", rationale: "hook bank" })).data;
  assert.equal(c.stage, "script");
  await forceStatus(c.id, "slides");
  const back = await call(mcp, "move_back", { id: c.id, reason: "redo slides" });
  assert.equal(back.data.status, "adapted");
  const [{ n }] = await sql("SELECT count(*)::int AS n FROM agent_actions WHERE tool = 'add_carousel' AND ok");
  assert.ok(n >= 2);
});
