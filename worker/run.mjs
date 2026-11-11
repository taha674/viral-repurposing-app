// Lecture reel render worker. Takes approved lecture reels waiting in Video with no upload, renders each one the way
// the first four Hifdh lecture reels were made (his clip cut from his video, cropped 3:2 full width at its own frame
// rate, film grain, his subtitles, the Caslon hook; lecture/build.py), then uploads it and strips it to Finished.
//   MCP_URL=https://<board>/api/mcp MCP_API_TOKEN=... node run.mjs            up to RENDER_LIMIT items (default 1)
//   LECTURE_ID=123 ...                                                          that item only
//   node run.mjs --local <item.json> <dir>                                       render one lectures.json item, no board
// Optional: YTDLP_COOKIES (a cookies.txt path) when YouTube asks the server to sign in; HYPERFRAMES (default "npx hyperframes").
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const ff = (...a) => run("ffmpeg", ["-v", "error", "-y", ...a]);
const seconds = (f) => Number(out("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));

// One lecture item -> <dir>/send.mp4. item: {url, hook_text, speaker, language, source_start, source_end, subtitles}
export function render(item, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { url, source_start: a, source_end: b } = item;
  if (a == null || b == null) throw new Error("The clip has no source range.");
  // His whole video (YouTube's section downloads drop streams), then his clip cut from it: picture and sound
  // together, cut where the voice is cut. Retries are capped (yt-dlp's own, 3 each).
  run("yt-dlp", [
    "-q", "--no-playlist", "--js-runtimes", "node", "-f", "bv*[height<=1080]+ba/b[height<=1080]", "--merge-output-format", "mkv",
    "--retries", "3", "--fragment-retries", "3",
    ...(process.env.YTDLP_COOKIES ? ["--cookies", process.env.YTDLP_COOKIES] : []),
    "-o", path.join(dir, "src.%(ext)s"), url,
  ]);
  const src = path.join(dir, "src.mkv");
  const cut = ["-ss", String(a), "-to", String(b), "-i", src];
  const dur = b - a;
  ff(...cut, "-vn", "-af", `aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.03,afade=t=out:st=${(dur - 0.06).toFixed(2)}:d=0.06,loudnorm=I=-16:TP=-1.5:LRA=11`,
    "-ar", "48000", "-b:a", "192k", path.join(dir, "voice.mp3"));
  // His own video, only cropped, at its own frame rate: 3:2 from the top 78% of the frame, centred, which keeps channel
  // logos and lower thirds in the corners and foot out of the picture (Taha, 10 Nov). Then full width.
  // ponytail: one heuristic crop for every source; a per-clip crop (as the first four had) when a speaker sits off-centre.
  const [n, d = 1] = out("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", src]).split("/").map(Number);
  ff(...cut, "-an", "-vf", "crop='min(iw,ih*0.78*3/2)':'min(ih*0.78,iw*2/3)':'(iw-ow)/2':0,scale=1080:720:flags=lanczos,setsar=1", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", path.join(dir, "face.mp4"));
  const caps = item.subtitles.split("\n").map((l) => l.match(/^([\d.]+)\s+(.*)$/)).filter(Boolean).map(([, t, rest]) => {
    const [orig, en] = item.language !== "English" && rest.includes(" / ") ? rest.split(" / ", 2) : ["", rest];
    return [Number(t), en.trim(), orig.trim()];
  });
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ hook: item.hook_text, speaker: item.speaker, fps: Math.round(n / d), vend: seconds(path.join(dir, "voice.mp3")), still: false, caps }));
  run("python3", [path.join(HERE, "lecture/build.py"), path.join(dir, "spec.json"), dir]);
  const [hf, ...hfArgs] = (process.env.HYPERFRAMES ?? "npx hyperframes").split(" ");
  run(hf, [...hfArgs, "render", "-o", "render.mp4", "--quiet"], dir);
  // the grain needs the bitrate
  ff("-i", path.join(dir, "render.mp4"), "-c:v", "libx264", "-preset", "slow", "-tune", "grain", "-crf", "18", "-maxrate", "14M", "-bufsize", "28M",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", path.join(dir, "send.mp4"));
  return path.join(dir, "send.mp4");
}

async function board() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const mcp = new Client({ name: "lecture-render-worker", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_API_TOKEN}` } } }));
  const call = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  const waiting = process.env.LECTURE_ID
    ? [{ id: Number(process.env.LECTURE_ID) }]
    : (await call("list_reels", { kind: "lecture", stage: "video" })).filter((r) => !r.has_source_video);
  for (const { id } of waiting.slice(0, Number(process.env.RENDER_LIMIT ?? 1))) {
    const reel = await call("get_reel", { id });
    if (reel.kind !== "lecture" || reel.status !== "video" || reel.source_video_path) throw new Error(`Item ${id} is not a lecture waiting for its render.`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lecture-${id}-`));
    try {
      const file = render({ ...reel.lecture, url: reel.url, subtitles: reel.adapted_script }, dir);
      const link = await call("create_video_upload_link", { id });
      const form = new FormData();
      form.append("video", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), `${reel.lecture.clip_id}.mp4`);
      const up = await fetch(link.upload_url, { method: "POST", body: form });
      if (!up.ok) throw new Error(`upload: ${up.status} ${await up.text()}`);
      const done = await call("burn_captions", { id });
      console.log(`${reel.lecture.clip_id}: ${done.status}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  await mcp.close();
}

if (process.argv[2] === "--local") {
  console.log(render(JSON.parse(fs.readFileSync(process.argv[3], "utf8")), path.resolve(process.argv[4])));
} else {
  await board();
}
