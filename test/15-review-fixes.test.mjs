// Regression tests for the review of tickets 06-14 (gate bypasses and
// state holes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, connect, call, original, forceStatus } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const QUOTE = { rationale: "t", operator_confirmed: true, confirmation_note: "Taha: yes" };
const textPost = async () =>
  (await call(mcp, "add_text_post", { brand: "nuronomics", channel: "whatsapp_channel", body: "Approved wording", rationale: "t" })).data;

test("a text post cannot be adapted into the reel pipeline around approve_item", async () => {
  const t = await textPost();
  // The web route has no paid-call cap, so it reaches the kind guard.
  const res = await fetch(`${BASE}/api/reels/${t.id}/adapt`, { method: "POST" });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not adapted/);
  await forceStatus(t.id, "adapted", { red_line_flag: "none" });
  const ap = await call(mcp, "approve_script", { id: t.id, rationale: "t" });
  assert.equal(ap.ok, false);
  assert.match(ap.error, /approve_item/);
});

test("approved text can't be edited by the agent; pending text can", async () => {
  const t = await textPost();
  assert.equal((await call(mcp, "edit_reel", { id: t.id, adapted_script: "Tweaked", rationale: "t" })).ok, true);
  await call(mcp, "approve_item", { id: t.id, ...QUOTE });
  const late = await call(mcp, "edit_reel", { id: t.id, adapted_script: "Sneaky", rationale: "t" });
  assert.equal(late.ok, false);
  assert.match(late.error, /approved/);
});

test("a carousel's slide text is not hand-edited; it takes the source reel's brand", async () => {
  const src = await original(mcp, { brand: "nuronomics" });
  await forceStatus(src.id, "approved", { adapted_script: "Approved." });
  const c = (await call(mcp, "add_carousel", { from_reel_id: src.id, rationale: "t" })).data;
  assert.equal(c.brand, "nuronomics", "brand comes from the source, not the cyrus default");
  const e = await call(mcp, "edit_reel", { id: c.id, adapted_script: "x", rationale: "t" });
  assert.equal(e.ok, false);
});

test("an archived story restores to Pending approval with no file", async () => {
  const s = (await call(mcp, "add_story", { brand: "nuronomics", text: "s", rationale: "t" })).data;
  await forceStatus(s.id, "posted", { captions_status: "success", captions_video_path: "/tmp/gone.jpg" });
  const a = await call(mcp, "archive_reel", { id: s.id, ...QUOTE });
  assert.equal(a.ok, true, a.error);
  const r = await call(mcp, "restore_reel", { id: s.id });
  assert.equal(r.data.status, "pending_approval");
  assert.equal(r.data.captions_status, "none");
  const ap = await call(mcp, "approve_item", { id: s.id, ...QUOTE });
  assert.equal(ap.ok, false, "the purged file must be re-uploaded first");
});
