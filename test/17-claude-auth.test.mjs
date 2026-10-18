// The temporary OpenRouter switch: which credential the Claude client
// sends. No network: the unit half is a pure function, the end-to-end half
// hits the fake endpoint in test/fake-treg.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { claudeAuth } from "../lib/claudeAuth.ts";
import { BASE, connect, original } from "./harness.mjs";
import { FAKE_BASE } from "./fake-treg.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

test("claudeAuth: auth token wins and never travels with an API key; API key otherwise", () => {
  assert.deepEqual(claudeAuth({ apiKey: "sk-ant-x", authToken: "" }), { apiKey: "sk-ant-x", authToken: null });
  assert.deepEqual(claudeAuth({ apiKey: "", authToken: "or-x" }), { apiKey: null, authToken: "or-x" });
  assert.deepEqual(claudeAuth({ apiKey: "sk-ant-x", authToken: "or-x" }), { apiKey: null, authToken: "or-x" });
  assert.deepEqual(claudeAuth({ apiKey: " ", authToken: " " }), { apiKey: null, authToken: null });
});

test("with ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL the adaptation goes there as Bearer, no x-api-key", async () => {
  await fetch(`${FAKE_BASE}/__fake/reset`, { method: "POST", body: "{}" });
  const r = await original(mcp, { brand: "nuronomics" });
  // The web route has no paid-call cap; the fake answers instead of Claude.
  const res = await fetch(`${BASE}/api/reels/${r.id}/adapt`, { method: "POST" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).reel.adapted_script, "Faked adaptation.");

  const calls = (await (await fetch(`${FAKE_BASE}/__fake/calls`)).json()).filter((c) => c.path === "claude:/v1/messages");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, "Bearer fake-openrouter-token");
  assert.equal(calls[0].xApiKey, null);
  assert.equal(calls[0].body.model, "anthropic/claude-opus-5.5");
  assert.equal(calls[0].body.output_config.format.type, "json_schema");
});
