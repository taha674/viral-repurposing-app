// Manual add judges a reel by its own brand's view floor (Nuronomics 50K,
// Cyrus 500K) and records the views, including a play count that only the
// provider's `raw` body carries. The fake treg serves the post detail with
// the plays in `raw` only; the shortcode V60000 means 60,000 plays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE } from "./harness.mjs";

const add = (shortcode, brand, force = false) =>
  fetch(`${BASE}/api/reels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://www.instagram.com/reel/${shortcode}/`, brand, force }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("Nuronomics: 60K plays clears its 50K floor and the views are recorded", async () => {
  const { status, body } = await add("V60000", "nuronomics");
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.reel.views, 60000);
  assert.equal(body.forced, false);
});

test("Nuronomics: 49K plays is refused with the 50K floor in the message", async () => {
  const { status, body } = await add("V49000", "nuronomics");
  assert.equal(status, 200);
  assert.equal(body.qualifies, false);
  assert.equal(body.views, 49000);
  assert.match(body.message, /Below the 50K-view threshold/);
});

test("Cyrus: the same 60K plays is below its 500K floor, and force records the views", async () => {
  const refused = await add("V60001", "cyrus");
  assert.equal(refused.body.qualifies, false);
  assert.match(refused.body.message, /Below the 500K-view threshold/);
  const forced = await add("V60001", "cyrus", true);
  assert.equal(forced.status, 201);
  assert.equal(forced.body.reel.views, 60001);
  assert.equal(forced.body.forced, true);
});
