// Ticket 01: the manual checks under "MCP server for Hermes" in tasks.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, connect, call, audits, original, forceStatus, sql } from "./harness.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const rpc = (headers) =>
  fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("401 without a token and with a wrong one", async () => {
  assert.equal((await rpc({})).status, 401);
  assert.equal((await rpc({ Authorization: "Bearer wrong" })).status, 401);
});

test("tools/list answers and exposes no posting or sending tool", async () => {
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["get_pipeline_overview", "approve_script", "add_original", "mark_posted"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  // Recording what the operator did (mark_posted, mark_sent) is fine; a tool
  // that publishes or sends is not.
  // send_to_video is a board move (Audio -> Video), not a send. The one
  // tool that posts is publish_to_instagram (root CLAUDE.md, Nuronomics
  // Instagram only, behind the operator's quoted approval).
  const doers = names.filter((n) => /publish(?!_pack)|^post_|^send_(?!to_video$)|_send$/.test(n));
  assert.deepEqual(doers, ["publish_to_instagram"]);
});

const approveIds = [];
async function adapted(flag) {
  const reel = await original(mcp);
  approveIds.push(reel.id);
  await forceStatus(reel.id, "adapted", { adapted_script: "An adapted script.", red_line_flag: flag, red_line_reason: `flag ${flag}` });
  return reel.id;
}

test("approve_script refuses a rejected flag, even with confirmation", async () => {
  const id = await adapted("rejected");
  const r = await call(mcp, "approve_script", { id, rationale: "t", operator_confirmed: true, confirmation_note: "yes" });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot approve/i);
});

test("approve_script needs the operator's quote for needs_review", async () => {
  const id = await adapted("needs_review");
  const without = await call(mcp, "approve_script", { id, rationale: "t" });
  assert.equal(without.ok, false);
  assert.match(without.error, /operator_confirmed/);
  const noQuote = await call(mcp, "approve_script", { id, rationale: "t", operator_confirmed: true });
  assert.equal(noQuote.ok, false);
  const ok = await call(mcp, "approve_script", { id, rationale: "t", operator_confirmed: true, confirmation_note: "Taha: approved" });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.data.status, "approved");
});

test("approve_script passes a clean flag without confirmation", async () => {
  const id = await adapted("none");
  const r = await call(mcp, "approve_script", { id, rationale: "clean" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.status, "approved");
});

test("paid tools are refused at the daily cap before any provider call", async () => {
  const reel = await original(mcp);
  const r = await call(mcp, "adapt_reel", { id: reel.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /Daily paid-call cap reached/);
  const scan = await call(mcp, "run_scan");
  assert.equal(scan.ok, false);
  assert.match(scan.error, /Daily scan cap reached/);
  // Refused at the cap: no audit row, nothing billed.
  assert.equal((await audits("adapt_reel")).filter((a) => a.reel_id === reel.id).length, 0);
});

test("every mutating call leaves an audit row, refusals included", async () => {
  const rows = (await audits("approve_script")).filter((r) => approveIds.includes(r.reel_id));
  assert.equal(rows.length, 5); // rejected, 2 refused needs_review, 1 ok needs_review, 1 clean
  assert.deepEqual(rows.map((r) => r.ok), [false, false, false, true, true]);
  assert.ok(rows.every((r) => r.reel_id !== null && r.rationale));
  const [{ n }] = await sql("SELECT count(*)::int AS n FROM agent_actions WHERE tool = 'add_original'");
  assert.ok(n >= 4);
});
