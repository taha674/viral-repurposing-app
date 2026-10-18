// Ticket 09: metrics, the hook summary and the weekly metrics cron.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, connect, call, original, forceStatus, sql } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const QUOTE = { rationale: "t", operator_confirmed: true, confirmation_note: "Taha: live" };
async function posted(hook, url) {
  const r = await original(mcp, { hook, brand: "cyrus" });
  await forceStatus(r.id, "captioned");
  const p = await call(mcp, "mark_posted", { id: r.id, links: [{ platform: "instagram", url }], ...QUOTE });
  assert.equal(p.ok, true, p.error);
  return r.id;
}

test("record_metrics is refused on an unposted item and keeps several readings", async () => {
  const draft = await original(mcp);
  const no = await call(mcp, "record_metrics", { id: draft.id, platform: "instagram", views: 10, rationale: "t" });
  assert.equal(no.ok, false);
  assert.match(no.error, /only to posted items/);

  const id = await posted("A", "https://www.instagram.com/reel/M1/");
  await call(mcp, "record_metrics", { id, platform: "instagram", views: 100, read_at: "2026-10-01T10:00:00Z", rationale: "week 1" });
  const two = await call(mcp, "record_metrics", { id, platform: "instagram", views: 400, three_second_rate: 0.6, saves: 5, comments: 3, rationale: "week 2" });
  assert.equal(two.ok, true, two.error);
  assert.equal(two.data.readings.length, 2);
  assert.equal((await call(mcp, "record_metrics", { id, platform: "instagram", three_second_rate: 1.5, rationale: "t" })).ok, false);
});

test("get_hook_summary: per-hook counts, medians of the latest reading, totals, month-to-date spend", async () => {
  const a2 = await posted("A", "https://www.instagram.com/reel/M2/");
  await call(mcp, "record_metrics", { id: a2, platform: "instagram", views: 1000, three_second_rate: 0.4, saves: 1, comments: 1, rationale: "t" });
  const b = await posted("B", "https://www.instagram.com/reel/M3/");
  await call(mcp, "record_metrics", { id: b, platform: "instagram", views: 50, rationale: "t" });
  await sql("INSERT INTO provider_spend (provider, endpoint, cost_micro) VALUES ('treg', 'test', 1500), ('treg', 'test', 2500)");

  const { data } = await call(mcp, "get_hook_summary", { brand: "cyrus" });
  const A = data.hooks.find((h) => h.hook === "A");
  const B = data.hooks.find((h) => h.hook === "B");
  assert.equal(A.items_posted, 2);
  assert.equal(A.median_views, 700); // latest readings 400 and 1000
  assert.equal(A.median_three_second_rate, 0.5);
  assert.equal(A.total_saves, 6);
  assert.equal(A.total_comments, 4);
  assert.equal(B.items_posted, 1);
  assert.equal(B.median_views, 50);
  assert.ok(data.month_to_date.treg_usd >= 0.004);
  assert.equal(typeof data.month_to_date.agent_paid_calls, "number");
});

test("the weekly metrics cron needs the secret and spends nothing when treg has no answer", async () => {
  assert.equal((await fetch(`${BASE}/api/cron/metrics`, { method: "POST" })).status, 401);
  const before = (await sql("SELECT count(*)::int AS n FROM provider_spend"))[0].n;
  const res = await fetch(`${BASE}/api/cron/metrics`, { method: "POST", headers: { Authorization: "Bearer test-cron-secret" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.read, 0);
  assert.ok(body.failed >= 3, "the fake treg answers no metrics read");
  assert.equal((await sql("SELECT count(*)::int AS n FROM provider_spend"))[0].n, before);
});
