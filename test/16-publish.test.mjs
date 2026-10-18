// Ticket 16: publish_to_instagram, with the Graph calls faked at the treg
// boundary (test/fake-treg.mjs). No real post can go out. The harness cap is
// 3 a day so all three kinds can publish before the cap refusal.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, call, audits, original, forceStatus, sql } from "./harness.mjs";
import { FAKE_BASE } from "./fake-treg.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const QUOTE = { rationale: "t", operator_confirmed: true, confirmation_note: "Taha: ✅ post it" };
const PACK = JSON.stringify({
  caption: "Most people revise by rereading.", caption_rationale: "", hashtags: ["hifz", "quran"], hashtags_rejected: [],
  thumbnail_text: [], hook_mode: "subtitle_only", hook_mode_reason: "", cover_frame_seconds: 1.5, cover_frame_line: null,
  red_line_flag: "none", red_line_reason: "",
});
const PAST = () => new Date(Date.now() - 60e3).toISOString();
const fakeCalls = async () => (await fetch(`${FAKE_BASE}/__fake/calls`)).json();
const fakeReset = (mode = "ok") => fetch(`${FAKE_BASE}/__fake/reset`, { method: "POST", body: JSON.stringify({ mode }) });

async function scheduledReel(brand = "nuronomics", at = PAST()) {
  const r = await original(mcp, { brand });
  await forceStatus(r.id, "captioned", { captions_status: "success", captions_video_path: "/tmp/x.mp4", publish_pack: PACK, publish_pack_status: "success" });
  const s = await call(mcp, "schedule_item", { id: r.id, planned_post_at: at, rationale: "t" });
  assert.equal(s.ok, true, s.error);
  return r.id;
}

test("refused without the quote, for Cyrus, off scheduled, and before the planned time; nothing reaches Instagram", async () => {
  await fakeReset();
  const id = await scheduledReel();
  const noQuote = await call(mcp, "publish_to_instagram", { id, rationale: "t", operator_confirmed: false, confirmation_note: "x" });
  assert.match(noQuote.error, /approval of this post/);

  const cyrus = await scheduledReel("cyrus");
  assert.match((await call(mcp, "publish_to_instagram", { id: cyrus, ...QUOTE })).error, /Cyrus posts stay manual/);

  const draft = await original(mcp);
  assert.match((await call(mcp, "publish_to_instagram", { id: draft.id, ...QUOTE })).error, /not scheduled/);

  const future = await scheduledReel("nuronomics", new Date(Date.now() + 3600e3).toISOString());
  assert.match((await call(mcp, "publish_to_instagram", { id: future, ...QUOTE })).error, /at or after that time/);

  assert.deepEqual(await fakeCalls(), []);
  assert.equal((await audits("publish_to_instagram")).filter((a) => !a.ok).length, 4, "refusals are audited");
});

test("a failed container leaves the item scheduled and says why", async () => {
  await fakeReset("error");
  const id = await scheduledReel();
  const r = await call(mcp, "publish_to_instagram", { id, ...QUOTE });
  assert.equal(r.ok, false);
  assert.match(r.error, /rejected the media \(ERROR\): video too long/);
  assert.equal((await call(mcp, "get_reel", { id })).data.status, "scheduled");
  assert.ok(!(await fakeCalls()).some((c) => c.path.endsWith("media_publish")), "never published");

  await fakeReset("stuck");
  const stuck = await call(mcp, "publish_to_instagram", { id, ...QUOTE });
  assert.match(stuck.error, /still processing after 3 checks/);
  assert.equal((await call(mcp, "get_reel", { id })).data.status, "scheduled");
});

test("a reel publishes: REELS container with the signed link and approved caption, permalink recorded as posted", async () => {
  await fakeReset();
  const id = await scheduledReel();
  const r = await call(mcp, "publish_to_instagram", { id, ...QUOTE });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.status, "posted");
  assert.match(r.data.post_links[0].url, /^https:\/\/www\.instagram\.com\/reel\/FAKEm\d+\/$/);

  const calls = await fakeCalls();
  const create = calls.find((c) => c.method === "POST" && c.path.endsWith("me/media"));
  assert.equal(create.body.media_type, "REELS");
  assert.match(create.body.video_url, /\/api\/mcp\/media\//);
  assert.equal(create.body.caption, "Most people revise by rereading.\n\n#hifz #quran");
  assert.equal(create.body.thumb_offset, "1500");
  for (const c of calls) {
    const sent = JSON.stringify(c).toLowerCase();
    assert.ok(!/ai_generated|aigc|ai_label|is_ai/.test(sent), "never sets an AI-content label");
  }
  assert.equal(calls.filter((c) => c.path.endsWith("media_publish")).length, 1);
});

test("a carousel publishes its slides as children in order; a story as STORIES", async () => {
  await fakeReset();
  const c = await original(mcp);
  await forceStatus(c.id, "captioned", { kind: "carousel", slide_paths: JSON.stringify(["/tmp/s1.png", "/tmp/s2.png", "/tmp/s3.png"]), publish_pack: PACK, publish_pack_status: "success" });
  await call(mcp, "schedule_item", { id: c.id, planned_post_at: PAST(), rationale: "t" });
  assert.equal((await call(mcp, "publish_to_instagram", { id: c.id, ...QUOTE })).ok, true);
  let calls = await fakeCalls();
  const children = calls.filter((x) => x.body?.is_carousel_item === "true");
  assert.deepEqual(children.map((x) => x.body.image_url.length > 0), [true, true, true]);
  const parent = calls.find((x) => x.body?.media_type === "CAROUSEL");
  assert.equal(parent.body.children.split(",").length, 3);

  await fakeReset();
  const s = (await call(mcp, "add_story", { brand: "nuronomics", text: "s", rationale: "t" })).data;
  await forceStatus(s.id, "captioned", { captions_status: "success", captions_video_path: "/tmp/story.jpg" });
  await call(mcp, "schedule_item", { id: s.id, planned_post_at: PAST(), rationale: "t" });
  assert.equal((await call(mcp, "publish_to_instagram", { id: s.id, ...QUOTE })).ok, true);
  calls = await fakeCalls();
  const story = calls.find((x) => x.body?.media_type === "STORIES");
  assert.ok(story.body.image_url && !story.body.video_url);
});

test("the daily cap refuses once today's live posts reach it", async () => {
  await fakeReset();
  const id = await scheduledReel();
  const r = await call(mcp, "publish_to_instagram", { id, ...QUOTE });
  assert.equal(r.ok, false);
  assert.match(r.error, /Daily Instagram publish cap reached \(3\/3\)/);
  assert.deepEqual(await fakeCalls(), []);
});

test("no publish tool configured means no publish: the tool name has no default", async () => {
  const { igPublishTool, checkPublishAccount } = await import("../lib/igTool.ts");
  assert.throws(() => igPublishTool(""), /INSTAGRAM_PUBLISH_TREG_TOOL is not set/);
  assert.throws(() => igPublishTool("  "), /not set/);
  assert.equal(igPublishTool("instagram-2"), "instagram-2");
  assert.throws(() => checkPublishAccount("thecyrusamin", "surahwise"), /connected to @thecyrusamin, not @surahwise/);
  assert.doesNotThrow(() => checkPublishAccount("SurahWise", "surahwise"));
});

test("a tool connected to the wrong account is refused before anything is created", async () => {
  // The cap (3) is spent by now, so check the preflight on its own path:
  // the refusal must come from the account check, not the cap.
  await sql("DELETE FROM agent_actions WHERE tool = 'publish_to_instagram' AND ok");
  await fakeReset("wrongaccount");
  const id = await scheduledReel();
  const r = await call(mcp, "publish_to_instagram", { id, ...QUOTE });
  assert.equal(r.ok, false);
  assert.match(r.error, /connected to @thecyrusamin, not @surahwise/);
  const calls = await fakeCalls();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET instagram-2/me"]);
  assert.equal((await call(mcp, "get_reel", { id })).data.status, "scheduled");
});
