// Tickets 05, 07 and 08 as built so far: the manual MCP smoke from
// multi-brand.md §7, automated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connect, call, audits, original, forceStatus, sql, REELS_DIR } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

test("an original enters at Script with its hook", async () => {
  const r = await original(mcp, { hook: "B" });
  assert.equal(r.status, "accepted");
  assert.equal(r.stage, "script");
  assert.equal(r.source, "original");
  assert.equal(r.hook, "B");
  assert.ok(r.slug);
  assert.ok(r.allowed_actions.includes("adapt_reel"));
});

test("set_hook changes and clears the tag, and refuses D", async () => {
  const r = await original(mcp, { hook: "A" });
  assert.equal((await call(mcp, "set_hook", { id: r.id, hook: "C", rationale: "t" })).data.hook, "C");
  assert.equal((await call(mcp, "set_hook", { id: r.id, hook: null, rationale: "t" })).data.hook, null);
  assert.equal((await call(mcp, "set_hook", { id: r.id, hook: "D", rationale: "t" })).ok, false);
});

test("schedule_item only takes a finished item", async () => {
  const r = await original(mcp);
  const early = await call(mcp, "schedule_item", { id: r.id, planned_post_at: "2026-10-24T18:00:00+01:00", rationale: "t" });
  assert.equal(early.ok, false);
  await forceStatus(r.id, "captioned");
  const ok = await call(mcp, "schedule_item", { id: r.id, planned_post_at: "2026-10-24T18:00:00+01:00", rationale: "t" });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "scheduled");
  assert.equal(new Date(ok.data.planned_post_at).toISOString(), "2026-10-24T17:00:00.000Z");
});

const LINK = { platform: "instagram", url: "https://www.instagram.com/reel/TEST1/" };

test("mark_posted needs the operator's quoted reply", async () => {
  const r = await original(mcp);
  await forceStatus(r.id, "captioned");
  const no = await call(mcp, "mark_posted", { id: r.id, links: [LINK], rationale: "t", operator_confirmed: false, confirmation_note: "x" });
  assert.equal(no.ok, false);
  assert.match(no.error, /operator's word/);
  const http = await call(mcp, "mark_posted", {
    id: r.id, links: [{ platform: "instagram", url: "http://x.com/a" }], rationale: "t", operator_confirmed: true, confirmation_note: "Taha: live",
  });
  assert.equal(http.ok, false);
  const rows = await audits("mark_posted");
  assert.ok(rows.some((a) => a.reel_id === r.id && a.ok === false));
});

test("several platform links on one item, files kept, move back drops the links", async () => {
  const r = await original(mcp);
  await forceStatus(r.id, "captioned");
  const dir = path.join(REELS_DIR, r.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${r.slug}-subtitled.mp4`), "x");

  const quote = { rationale: "t", operator_confirmed: true, confirmation_note: "Taha: live on IG and Shorts" };
  const two = await call(mcp, "mark_posted", {
    id: r.id, links: [LINK, { platform: "youtube_shorts", url: "https://youtube.com/shorts/T1" }], ...quote,
  });
  assert.equal(two.ok, true, two.error);
  assert.equal(two.data.status, "posted");
  const three = await call(mcp, "mark_posted", { id: r.id, links: [{ platform: "tiktok", url: "https://www.tiktok.com/@x/video/1" }], ...quote });
  assert.deepEqual(three.data.post_links.map((l) => l.platform), ["instagram", "youtube_shorts", "tiktok"]);
  assert.ok(fs.existsSync(path.join(dir, `${r.slug}-subtitled.mp4`)), "posting must keep the files");

  // Never scheduled: back to Subtitled, links gone.
  const back = await call(mcp, "move_back", { id: r.id, reason: "mistaken mark" });
  assert.equal(back.data.status, "captioned");
  assert.deepEqual(back.data.post_links, []);
});

test("a scheduled item moved back from Posted keeps its time", async () => {
  const r = await original(mcp);
  await forceStatus(r.id, "captioned");
  await call(mcp, "schedule_item", { id: r.id, planned_post_at: "2026-10-25T18:00:00Z", rationale: "t" });
  await call(mcp, "mark_posted", { id: r.id, links: [LINK], rationale: "t", operator_confirmed: true, confirmation_note: "Taha: live" });
  const back = await call(mcp, "move_back", { id: r.id, reason: "t" });
  assert.equal(back.data.status, "scheduled");
  assert.ok(back.data.planned_post_at);
});

test("archive_reel refuses anything but Subtitled or Posted", async () => {
  const r = await original(mcp);
  const a = await call(mcp, "archive_reel", { id: r.id, rationale: "t", operator_confirmed: true, confirmation_note: "x" });
  assert.equal(a.ok, false);
  assert.match(a.error, /Only a Subtitled or Posted reel/);
  const [row] = await sql("SELECT status FROM reels WHERE id = $1", [r.id]);
  assert.equal(row.status, "accepted");
});
