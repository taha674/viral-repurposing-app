// Load the Hifdh lecture reels onto the board over MCP, the way Hermes would.
//   MCP_URL=https://<board>/api/mcp MCP_API_TOKEN=... node scripts/import-lectures.mjs <lectures.json> [<root for video paths>]
// lectures.json: one object per clip (inbox/reel-style/reels/lectures/lectures.json in the Hifdh repo).
// Every clip goes through add_lecture (re-runnable: a known clip_id returns its item). A clip that is already
// built carries `video` and `approved_note`: it is approved with that quote, its reel uploaded and stripped, and
// its caption set as the publish pack. One with `posted_links` and `posted_note` is then marked posted.
// Order: alts, then leads from the last in the queue to the first, so #1 sits at the top of its column.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [file, root = "."] = process.argv.slice(2);
const { MCP_URL, MCP_API_TOKEN } = process.env;
if (!file || !MCP_URL || !MCP_API_TOKEN) throw new Error("Usage: MCP_URL=... MCP_API_TOKEN=... node scripts/import-lectures.mjs <lectures.json> [root]");

const mcp = new Client({ name: "import-lectures", version: "1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${MCP_API_TOKEN}` } } }));
async function call(name, args) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const items = JSON.parse(fs.readFileSync(file, "utf8"));
const order = (i) => (i.role === "alt" ? -1e6 : i.video ? 1e6 : -(i.queue_order ?? 1e5));
items.sort((a, b) => order(a) - order(b));
// built reels last, in file order, so they are the newest cards
const rationale = "Hifdh lecture shortlist import (Taha, 11 Nov: one central pipeline)";
let n = 0;
for (const it of items) {
  const { video, approved_note, posted_note, posted_links, caption, hashtags, ...lecture } = it;
  const strip = Object.fromEntries(Object.entries(lecture).filter(([, v]) => v !== null && v !== undefined));
  let reel = await call("add_lecture", { brand: "nuronomics", ...strip, rationale });
  if (video && !approved_note?.trim()) throw new Error(`${it.clip_id}: a built reel needs approved_note, the operator's quoted approval`);
  if (posted_links?.length && !posted_note?.trim()) throw new Error(`${it.clip_id}: posted_links need posted_note, the operator's quoted reply`);
  if (video && reel.status === "adapted") {
    reel = await call("approve_script", { id: reel.id, rationale, operator_confirmed: true, confirmation_note: approved_note });
  }
  if (video && reel.status === "video" && !reel.source_video_path) {
    const link = await call("create_video_upload_link", { id: reel.id });
    const form = new FormData();
    form.append("video", new Blob([fs.readFileSync(path.join(root, video))], { type: "video/mp4" }), path.basename(video));
    const up = await fetch(link.upload_url, { method: "POST", body: form });
    if (!up.ok) throw new Error(`upload ${it.clip_id}: ${up.status} ${await up.text()}`);
    reel = await call("burn_captions", { id: reel.id });
  }
  if (caption) {
    const publish_pack = {
      caption, caption_rationale: "Final caption from POSTS.md, approved by Taha at post time", hashtags, hashtags_rejected: [],
      thumbnail_text: [], hook_mode: "subtitle_only", hook_mode_reason: "The hook is set in the reel", cover_frame_seconds: null,
      cover_frame_line: null, red_line_flag: "needs_review", red_line_reason: "Not run through the red-line filter: Taha approves this caption at post time",
    };
    reel = await call("edit_reel", { id: reel.id, publish_pack, rationale });
  }
  if (posted_links?.length && reel.status === "captioned") {
    reel = await call("mark_posted", { id: reel.id, links: posted_links, operator_confirmed: true, confirmation_note: posted_note, rationale });
  }
  const note = video && !posted_links?.length && posted_note ? " (posted: no link yet, so it waits in Finished)" : "";
  console.log(`${++n}/${items.length} ${it.clip_id}: ${reel.status}${note}`);
}
await mcp.close();
