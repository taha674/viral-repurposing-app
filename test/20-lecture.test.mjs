// Lecture reels: a scholar's own clip skips Script, Adaptation's adapt and
// Audio. Approval (same red-line rails) goes straight to Video; the upload is
// stripped, not burned; then Finished and Posted like any reel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, call } from "./harness.mjs";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const lecture = (clip_id, extra = {}) =>
  call(mcp, "add_lecture", {
    brand: "nuronomics",
    clip_id,
    speaker: "Dr. Muhammad al-Hindi",
    language: "Arabic",
    hook_text: "How do you remember what you memorised months ago?",
    source_url: "https://www.youtube.com/watch?v=rYsHsi-hoAM",
    subtitles: "0.7 وأما بالنسبة للحفظ البعيد / As for your old memorisation,",
    role: "lead",
    queue_order: 1,
    quranic_text: false,
    rationale: "test",
    ...extra,
  });

test("a lead clip enters at Adaptation as a lecture, and re-adding it returns the same item", async () => {
  const r = await lecture("t-lead");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.kind, "lecture");
  assert.equal(r.data.stage, "adaptation");
  assert.equal(r.data.lecture.speaker, "Dr. Muhammad al-Hindi");
  assert.ok(!r.data.allowed_actions.includes("adapt_reel"));
  assert.equal((await lecture("t-lead")).data.id, r.data.id);

  // Refused either way: the harness's paid-call cap is 0, and the service
  // refuses a lecture before any paid call.
  assert.equal((await call(mcp, "adapt_reel", { id: r.data.id })).ok, false);

  const listed = await call(mcp, "list_reels", { kind: "lecture" });
  assert.ok(listed.data.every((x) => x.kind === "lecture"));
  assert.equal(listed.data.find((x) => x.id === r.data.id).lecture.clip_id, "t-lead");
});

test("an alt waits in Scraped; accepting it skips Script", async () => {
  const r = await lecture("t-alt", { role: "alt", queue_order: undefined });
  assert.equal(r.data.stage, "scraped");
  const acc = await call(mcp, "accept_reel", { id: r.data.id, rationale: "test" });
  assert.equal(acc.data.stage, "adaptation");
});

test("a hadith on screen needs the operator's quote; approval goes straight to Video, then stripped and posted", async () => {
  const r = await lecture("t-hadith", { quranic_text: true, needs_review: "Sahih Muslim 791" });
  const id = r.data.id;
  assert.equal(r.data.red_line_flag, "needs_review");
  assert.equal((await call(mcp, "approve_script", { id, rationale: "t" })).ok, false);
  const ok = await call(mcp, "approve_script", { id, rationale: "t", operator_confirmed: true, confirmation_note: "approved" });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "video");

  const back = await call(mcp, "move_back", { id, reason: "t" });
  assert.equal(back.data.status, "adapted");
  await call(mcp, "approve_script", { id, rationale: "t", operator_confirmed: true, confirmation_note: "approved" });

  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lecture-")), "reel.mp4");
  execFileSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1",
    "-metadata", "title=SECRET", "-c:v", "libx264", "-c:a", "aac", "-shortest", src,
  ], { stdio: "ignore" });
  const link = await call(mcp, "create_video_upload_link", { id });
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(src)], { type: "video/mp4" }), "reel.mp4");
  assert.equal((await fetch(link.data.upload_url, { method: "POST", body: form })).status, 200);
  const done = await call(mcp, "burn_captions", { id });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.data.status, "captioned");

  const posted = await call(mcp, "mark_posted", {
    id,
    links: [{ platform: "instagram", url: "https://www.instagram.com/reel/TEST/" }],
    operator_confirmed: true,
    confirmation_note: "I have posted it",
    rationale: "t",
  });
  assert.equal(posted.ok, true, posted.error);
  assert.equal(posted.data.status, "posted");
});
