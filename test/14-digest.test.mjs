// Ticket 14: get_operator_queue, everything waiting on the operator, by brand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, call, original, forceStatus } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

test("each section, split by brand, stories and text posts included", async () => {
  const script = await original(mcp, { brand: "nuronomics" });
  await forceStatus(script.id, "adapted", { adapted_script: "x", red_line_flag: "needs_review", red_line_reason: "a claim" });
  const cyrusScript = await original(mcp, { brand: "cyrus" });
  await forceStatus(cyrusScript.id, "adapted", { adapted_script: "y" });

  const story = (await call(mcp, "add_story", { brand: "nuronomics", text: "story", rationale: "t" })).data;
  const text = (await call(mcp, "add_text_post", { brand: "nuronomics", channel: "whatsapp_channel", body: "Day 1", rationale: "t" })).data;

  const ready = await original(mcp, { brand: "nuronomics", hook: "A" });
  await forceStatus(ready.id, "captioned");
  // Midday IST today, so it is "today" in the default zone.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  await call(mcp, "schedule_item", { id: ready.id, planned_post_at: `${day}T12:00:00+05:30`, rationale: "t" });

  const failed = await original(mcp, { brand: "nuronomics" });
  await forceStatus(failed.id, "approved", { voiceover_status: "failed", voiceover_error: "quota" });

  const d = (await call(mcp, "draft_engagement", {
    brand: "nuronomics", kind: "comment", platform: "instagram", target_url: "https://www.instagram.com/p/X/",
    context: "Any tips?", draft: "Mark weak pages.", rationale: "t",
  })).data;

  const { data } = await call(mcp, "get_operator_queue", {});
  assert.equal(data.timezone, "Asia/Kolkata");
  const n = data.brands.nuronomics;
  const c = data.brands.cyrus;
  const scriptRow = n.scripts_awaiting_approval.find((r) => r.id === script.id);
  assert.equal(scriptRow.red_line_flag, "needs_review");
  assert.equal(scriptRow.red_line_reason, "a claim");
  assert.ok(!n.scripts_awaiting_approval.some((r) => r.id === cyrusScript.id));
  assert.ok(c.scripts_awaiting_approval.some((r) => r.id === cyrusScript.id));
  assert.deepEqual(n.items_pending_approval.map((r) => r.id).filter((id) => [story.id, text.id].includes(id)).sort(), [story.id, text.id].sort());
  assert.ok(n.ready_posts_today.some((p) => p.id === ready.id && p.hook === "A"));
  assert.ok(n.engagement_awaiting_approval.some((e) => e.number === d.id));
  assert.ok(n.failed_steps.some((f) => f.id === failed.id && f.step === "voiceover" && f.error === "quota"));
});
