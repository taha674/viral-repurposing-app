// Tickets 11 and 12: stories, text posts and the approve_item gate.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, call, audits } from "./harness.mjs";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");
const FFPROBE = require("ffprobe-static").path;

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const QUOTE = { operator_confirmed: true, confirmation_note: "Taha: yes, approved" };
const SOON = () => new Date(Date.now() + 3600e3).toISOString();

async function upload(url, file) {
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(file)]), path.basename(file));
  const res = await fetch(url, { method: "POST", body: form });
  assert.equal(res.status, 200, await res.text());
}

test("a story: pending approval, upload stripped, scheduling refused until approve_item with the quote", async () => {
  const add = await call(mcp, "add_story", { brand: "nuronomics", hook: "B", text: "Weak-page map screenshot", rationale: "daily story" });
  assert.equal(add.ok, true, add.error);
  const story = add.data;
  assert.equal(story.status, "pending_approval");
  assert.equal(story.stage, "pending");
  assert.equal(story.kind, "story");

  // A JPEG carrying a title and comment.
  const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "story-")), "story.jpg");
  execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=green:s=108x192", "-frames:v", "1", "-metadata", "title=SECRET", "-metadata", "comment=phone", img], { stdio: "ignore" });

  const early = await call(mcp, "approve_item", { id: story.id, rationale: "t", ...QUOTE });
  assert.equal(early.ok, false, "no file yet");
  assert.match(early.error, /Upload the story/);

  await upload(story.upload_url, img);
  const sched = await call(mcp, "schedule_item", { id: story.id, planned_post_at: SOON(), rationale: "t" });
  assert.equal(sched.ok, false, "unapproved story must not schedule");

  const noQuote = await call(mcp, "approve_item", { id: story.id, rationale: "t", operator_confirmed: false, confirmation_note: "x" });
  assert.equal(noQuote.ok, false);
  assert.match(noQuote.error, /operator's word/);

  const ok = await call(mcp, "approve_item", { id: story.id, rationale: "t", ...QUOTE });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "captioned");
  const out = ok.data.captions_video_path;
  assert.match(out, /-story\.jpg$/);
  const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", out]));
  assert.equal(probe.format.tags?.title, undefined);
  assert.equal(probe.format.tags?.comment, undefined);

  assert.equal((await call(mcp, "schedule_item", { id: story.id, planned_post_at: SOON(), rationale: "t" })).ok, true);
  const ready = (await call(mcp, "list_ready_posts", {})).data.find((p) => p.id === story.id);
  assert.equal(ready.kind, "story");
  assert.match(ready.files.video_url, /\/api\/mcp\/media\//);
  assert.deepEqual(ready.missing, []);
  const media = await fetch(ready.files.video_url);
  assert.equal(media.headers.get("content-type"), "image/jpeg");

  const rows = (await audits("approve_item")).filter((r) => r.reel_id === story.id);
  assert.deepEqual(rows.map((r) => r.ok), [false, false, true]);
});

test("text posts: same gate; email marked posted with no link, others need one", async () => {
  const bad = await call(mcp, "add_text_post", { brand: "nuronomics", channel: "fax", body: "x", rationale: "t" });
  assert.equal(bad.ok, false);

  const email = (await call(mcp, "add_text_post", { brand: "nuronomics", channel: "email", body: "Salaam, the test opens Saturday.", rationale: "launch email" })).data;
  assert.equal(email.status, "pending_approval");
  assert.equal((await call(mcp, "schedule_item", { id: email.id, planned_post_at: SOON(), rationale: "t" })).ok, false);
  assert.equal((await call(mcp, "approve_item", { id: email.id, rationale: "t", ...QUOTE })).ok, true);
  assert.equal((await call(mcp, "schedule_item", { id: email.id, planned_post_at: SOON(), rationale: "t" })).ok, true);
  const ready = (await call(mcp, "list_ready_posts", {})).data.find((p) => p.id === email.id);
  assert.equal(ready.channel, "email");
  assert.equal(ready.body, "Salaam, the test opens Saturday.");
  const sent = await call(mcp, "mark_posted", { id: email.id, links: [], rationale: "t", ...QUOTE });
  assert.equal(sent.ok, true, sent.error);
  assert.equal(sent.data.status, "posted");

  const wa = (await call(mcp, "add_text_post", { brand: "nuronomics", channel: "whatsapp_channel", body: "Day 3 tip", rationale: "t" })).data;
  await call(mcp, "approve_item", { id: wa.id, rationale: "t", ...QUOTE });
  assert.equal((await call(mcp, "mark_posted", { id: wa.id, links: [], rationale: "t", ...QUOTE })).ok, false);
  const linked = await call(mcp, "mark_posted", {
    id: wa.id, links: [{ platform: "whatsapp_channel", url: "https://whatsapp.com/channel/X/1" }], rationale: "t", ...QUOTE,
  });
  assert.equal(linked.ok, true, linked.error);

  for (const tool of ["add_story", "add_text_post"]) assert.ok((await audits(tool)).length >= 1, tool);
});
