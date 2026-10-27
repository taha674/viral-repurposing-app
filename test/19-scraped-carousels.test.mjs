// Scraped carousels for Nuronomics: a scan reads the hashtag feed and the
// account's posts, applies the likes floor (500) before any paid read, and
// one vision call per candidate both filters for hifz and reads the slide
// text. The fake treg serves four hashtag carousels (CARA 600 likes, CARB 100,
// CARC 900 but off-topic, plus a reel that must be ignored) and one account
// carousel (CARE 700) with a video slide; Cyrus sources are never read for
// carousels.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, connect } from "./harness.mjs";
import { FAKE_BASE } from "./fake-treg.mjs";

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const reelsOf = async (brand) => (await (await fetch(`${BASE}/api/reels?brand=${brand}`)).json()).reels;
const visionCalls = async () =>
  (await (await fetch(`${FAKE_BASE}/__fake/calls`)).json()).filter(
    (c) => c.path === "claude:/v1/messages" && c.body?.output_config?.format?.schema?.properties?.text
  );

test("a scan saves the hifz carousels above the likes floor and nothing else", async () => {
  await fetch(`${FAKE_BASE}/__fake/reset`, { method: "POST", body: "{}" });
  assert.equal((await post("/api/hashtags", { tag: "hifzfake", brand: "nuronomics" })).status, 201);
  assert.equal((await post("/api/accounts", { handle: "hifzacct", brand: "nuronomics" })).status, 201);

  const res = await post("/api/scan");
  assert.equal(res.status, 200, await res.clone().text());

  const carousels = (await reelsOf("nuronomics")).filter((r) => r.kind === "carousel" && /^CAR/.test(r.shortcode));
  assert.deepEqual(carousels.map((r) => r.shortcode).sort(), ["CARA", "CARE"]);
  const a = carousels.find((r) => r.shortcode === "CARA");
  assert.equal(a.source, "hashtag_scan");
  assert.equal(a.status, "transcribed");
  assert.equal(a.views, null);
  assert.match(a.transcript_excerpt, /^1\. Slide 1 text\n2\. Slide 2 text\n3\. Slide 3 text/);
  assert.deepEqual(JSON.parse(JSON.stringify(a.source_hashtags)), ["hifz"]);
  const e = carousels.find((r) => r.shortcode === "CARE");
  assert.equal(e.source, "weekly_scan");
  assert.equal(e.transcript_excerpt, "1. Slide 1 text"); // the video slide was dropped
  assert.notEqual(e.account_id, null);
  assert.equal((await reelsOf("nuronomics")).some((r) => r.shortcode === "REELX"), false);
});

test("below-floor carousels are never read; one read per candidate sent every slide", async () => {
  const calls = await visionCalls();
  // CARA, CARC (hashtag) and CARE (account) were read; CARB (100 likes) was not.
  assert.equal(calls.length, 3);
  const imageCounts = calls.map((c) => c.body.messages[0].content.filter((b) => b.type === "image").length).sort();
  assert.deepEqual(imageCounts, [1, 1, 3]);
});

test("the scan log says what was kept and why the rest was not", async () => {
  const { logs } = await (await fetch(`${BASE}/api/scan`)).json();
  const tag = logs.find((l) => l.handle === "#hifzfake");
  assert.match(tag.message, /carousels: 1 new, 1 under the likes floor, 1 not hifz/);
  const acct = logs.find((l) => l.handle === "hifzacct");
  assert.match(acct.message, /carousels: 1 new, 0 under the likes floor, 0 not hifz/);
});

test("a second scan adds no duplicates and Cyrus gets no carousels", async () => {
  assert.equal((await post("/api/scan")).status, 200);
  const carousels = (await reelsOf("nuronomics")).filter((r) => r.kind === "carousel" && /^CAR/.test(r.shortcode));
  assert.equal(carousels.length, 2);
  assert.equal((await reelsOf("cyrus")).some((r) => r.kind === "carousel" && /^CAR/.test(r.shortcode)), false);
});
