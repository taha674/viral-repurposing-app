// Ticket 07: unschedule_item and list_ready_posts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, call, audits, original, forceStatus } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const PACK = {
  caption: "Most people revise by rereading.",
  caption_rationale: "r",
  hashtags: ["hifz", "quran"],
  hashtags_rejected: [],
  thumbnail_text: [{ text: "MARK WEAK PAGES", technique: "t", why_not_clickbait: "w" }],
  hook_mode: "subtitle_plus_sticker",
  hook_mode_reason: "r",
  cover_frame_seconds: 1.2,
  cover_frame_line: "Mark the pages",
  red_line_flag: "none",
  red_line_reason: "",
};

async function scheduled(at, withPack = true) {
  const r = await original(mcp, { hook: "A" });
  await forceStatus(r.id, "captioned", {
    captions_status: "success",
    captions_video_path: "/tmp/none.mp4",
    ...(withPack ? { publish_pack: JSON.stringify(PACK), publish_pack_status: "success" } : {}),
  });
  const s = await call(mcp, "schedule_item", { id: r.id, planned_post_at: at, rationale: "t" });
  assert.equal(s.ok, true, s.error);
  return r.id;
}

test("list_ready_posts returns the window's items with file link, caption, hashtags and cover text", async () => {
  const soon = new Date(Date.now() + 3600e3).toISOString();
  const later = new Date(Date.now() + 5 * 864e5).toISOString();
  const a = await scheduled(soon);
  const b = await scheduled(later);
  const { data } = await call(mcp, "list_ready_posts", { brand: "nuronomics" });
  const ids = data.map((p) => p.id);
  assert.ok(ids.includes(a));
  assert.ok(!ids.includes(b), "outside the default 24h window");
  const p = data.find((x) => x.id === a);
  assert.match(p.files.video_url, /\/api\/mcp\/media\//);
  assert.equal(p.caption, PACK.caption);
  assert.deepEqual(p.hashtags, PACK.hashtags);
  assert.deepEqual(p.cover_text, ["MARK WEAK PAGES"]);
  assert.equal(p.hook, "A");
  assert.deepEqual(p.missing, []);

  const wide = await call(mcp, "list_ready_posts", { from: new Date().toISOString(), to: new Date(Date.now() + 7 * 864e5).toISOString() });
  assert.ok(wide.data.some((x) => x.id === b));
});

test("a ready post without a publish pack says so", async () => {
  const id = await scheduled(new Date(Date.now() + 7200e3).toISOString(), false);
  const { data } = await call(mcp, "list_ready_posts", {});
  const p = data.find((x) => x.id === id);
  assert.equal(p.caption, null);
  assert.deepEqual(p.missing, ["publish_pack"]);
});

test("unschedule_item returns the item to finished with no time; refuses an unscheduled one", async () => {
  const id = await scheduled(new Date(Date.now() + 3600e3).toISOString());
  const u = await call(mcp, "unschedule_item", { id, rationale: "plan changed" });
  assert.equal(u.ok, true, u.error);
  assert.equal(u.data.status, "captioned");
  assert.equal(u.data.planned_post_at, null);
  const again = await call(mcp, "unschedule_item", { id, rationale: "t" });
  assert.equal(again.ok, false);
  const rows = (await audits("unschedule_item")).filter((r) => r.reel_id === id);
  assert.deepEqual(rows.map((r) => r.ok), [true, false]);
});
