// Ticket 13: the engagement queue.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, call, audits, sql } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const QUOTE = { operator_confirmed: true, confirmation_note: "Taha: send it" };
const draft = (extra = {}) =>
  call(mcp, "draft_engagement", {
    brand: "nuronomics", kind: "reply", platform: "reddit", target_url: "https://reddit.com/r/hifz/comments/abc",
    context: "How do you keep your manzil?", draft: "I mark weak pages with a dot.", rationale: "on topic", ...extra,
  });

test("no send tool exists", async () => {
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  for (const t of ["draft_engagement", "list_engagement", "approve_engagement", "drop_engagement", "mark_sent"]) assert.ok(names.includes(t), t);
  assert.deepEqual(names.filter((n) => /^send_(?!to_video$)|_send$|reply_to|post_comment|send_dm/.test(n)), []);
});

test("approve needs confirmation and the quote; edited text is kept; numbering is stable", async () => {
  const d = (await draft()).data;
  const n = (await draft({ draft: "second" })).data;
  assert.ok(n.id > d.id);
  const no = await call(mcp, "approve_engagement", { id: d.id, rationale: "t", operator_confirmed: false, confirmation_note: "x" });
  assert.equal(no.ok, false);
  assert.match(no.error, /operator's word/);
  const ok = await call(mcp, "approve_engagement", { id: d.id, rationale: "t", ...QUOTE, approved_text: "I mark weak pages with a pencil dot." });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "approved");
  assert.equal(ok.data.approved_text, "I mark weak pages with a pencil dot.");
  assert.equal(ok.data.draft, "I mark weak pages with a dot.");
  assert.equal(ok.data.confirmation_note, "Taha: send it");
  const listed = (await call(mcp, "list_engagement", { brand: "nuronomics" })).data;
  assert.deepEqual(listed.map((e) => e.id).slice(0, 2), [d.id, n.id]);

  assert.equal((await call(mcp, "mark_sent", { id: n.id, rationale: "t" })).ok, false, "a draft cannot be marked sent");
  const sent = await call(mcp, "mark_sent", { id: d.id, rationale: "Taha: pasted" });
  assert.equal(sent.data.status, "sent");
  assert.deepEqual((await audits("approve_engagement")).map((a) => a.ok).slice(-2), [false, true]);
});

test("drop takes a reason; an approved draft expires after 48 hours unsent", async () => {
  const a = (await draft()).data;
  const dropped = await call(mcp, "drop_engagement", { id: a.id, reason: "thread is stale" });
  assert.equal(dropped.data.status, "dropped");
  assert.equal(dropped.data.drop_reason, "thread is stale");

  const b = (await draft()).data;
  await call(mcp, "approve_engagement", { id: b.id, rationale: "t", ...QUOTE });
  await sql("UPDATE engagement SET approved_at = now() - interval '49 hours' WHERE id = $1", [b.id]);
  const expired = (await call(mcp, "list_engagement", { status: "expired" })).data;
  assert.ok(expired.some((e) => e.id === b.id));
  const late = await call(mcp, "mark_sent", { id: b.id, rationale: "t" });
  assert.equal(late.ok, false);
  assert.match(late.error, /expired/);
});

test("the per-platform daily cap refuses past its limit", async () => {
  const x = { platform: "x", target_url: "https://x.com/a/status/1" };
  assert.equal((await draft(x)).ok, true);
  assert.equal((await draft(x)).ok, true);
  const third = await draft(x);
  assert.equal(third.ok, false);
  assert.match(third.error, /Daily x comment draft cap reached \(2\/2\)/);
  // DMs are their own bucket; X DMs were not researched, so the cap is 0.
  const dm = await draft({ ...x, kind: "dm" });
  assert.equal(dm.ok, false);
  assert.match(dm.error, /Daily x dm draft cap reached \(0\/0\)/);
});
