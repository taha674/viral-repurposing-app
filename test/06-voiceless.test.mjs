// Ticket 06: a voiceless original skips the voiceover and its upload is
// metadata-stripped and finished, with no subtitle burn.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { connect, call, original, forceStatus } from "./harness.mjs";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");
const FFPROBE = require("ffprobe-static").path;

let mcp;
before(async () => {
  mcp = await connect();
});
after(() => mcp.close());

test("voiced originals are unchanged: no voiceover, no Video", async () => {
  const r = await original(mcp);
  assert.equal(r.voiceless, false);
  await forceStatus(r.id, "approved");
  const send = await call(mcp, "send_to_video", { id: r.id });
  assert.equal(send.ok, false);
  assert.match(send.error, /voiceover first/);
});

test("a voiceless original goes Approved → Video → finished, stripped, no burn", async () => {
  const r = await original(mcp, { voiceless: true });
  assert.equal(r.voiceless, true);
  await forceStatus(r.id, "approved");
  const got = await call(mcp, "get_reel", { id: r.id });
  assert.ok(got.data.allowed_actions.includes("send_to_video"));
  assert.ok(!got.data.allowed_actions.includes("generate_voiceover"));
  assert.equal((await call(mcp, "send_to_video", { id: r.id })).data.status, "video");

  // A 1-second clip carrying the tags the strip must remove.
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voiceless-")), "demo.mp4");
  execFileSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1",
    "-metadata", "title=SECRET TITLE", "-metadata", "artist=Someone", "-metadata", "comment=made on a phone",
    "-metadata", "creation_time=2024-01-01T00:00:00Z", "-c:v", "libx264", "-c:a", "aac", "-shortest", src,
  ], { stdio: "ignore" });

  const link = await call(mcp, "create_video_upload_link", { id: r.id });
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(src)], { type: "video/mp4" }), "demo.mp4");
  const up = await fetch(link.data.upload_url, { method: "POST", body: form });
  assert.equal(up.status, 200, await up.text());

  const done = await call(mcp, "burn_captions", { id: r.id });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.data.status, "captioned");
  assert.equal(done.data.captions_status, "success");

  const out = done.data.captions_video_path;
  const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", out]));
  const tags = [probe.format.tags ?? {}, ...probe.streams.map((s) => s.tags ?? {})];
  for (const t of tags) {
    for (const key of ["title", "artist", "comment", "creation_time"]) {
      assert.equal(t[key], undefined, `${key} left on the stripped file: ${JSON.stringify(t)}`);
    }
  }
});
