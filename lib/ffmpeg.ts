import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
// @ts-expect-error -- ffprobe-static has no bundled types.
import ffprobeStatic from "ffprobe-static";
import { config } from "./config";

const execFileAsync = promisify(execFile);

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = (ffprobeStatic as { path: string }).path;
// Bundled in the repo (assets/fonts/) rather than relying on the OS having
// this font installed — Railway's runtime image has no fonts by default,
// so pointing libass at a fontsdir keeps caption rendering identical
// between local dev and production instead of silently falling back to
// whatever's on the box.
const FONTS_DIR = path.join(process.cwd(), "assets", "fonts");

export interface VideoProbe {
  durationSeconds: number;
  width: number;
  height: number;
}

export async function probeVideo(videoPath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    videoPath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = data.streams?.[0];
  const duration = Number(data.format?.duration);
  if (!stream?.width || !stream?.height || !Number.isFinite(duration)) {
    throw new Error(`Could not probe video at ${videoPath}`);
  }
  return { durationSeconds: duration, width: stream.width, height: stream.height };
}

// Extracted as 16kHz mono WAV — the input format the local Whisper model expects.
export async function extractAudioForTranscription(
  videoPath: string,
  outWavPath: string
): Promise<void> {
  await execFileAsync(
    FFMPEG,
    [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outWavPath,
    ],
    { timeout: config.captionsFfmpegTimeoutMs }
  );
}

// Burns the given ASS subtitle file into the video and strips all metadata
// in the same pass (project rule: every video the pipeline produces must be
// metadata-stripped before it's "done"). Re-encodes video (subtitles are
// burned pixels, not a track) but copies audio through untouched.
//
// `punchChain`, when given, is a -filter_complex graph (lib/punchIn.ts) that
// applies the punch-in zoom and leaves the result on [punched].
//
// ORDER IS LOAD-BEARING: the zoom runs BEFORE ass. Burning subtitles first
// and zooming after would scale the subtitles along with the frame — they'd
// grow, drift off centre, and crop at the edges. Zooming first keeps the ASS
// geometry (PlayResX/PlayResY from probeVideo, captionBaselineY, and the
// WIDTH_CALIBRATION fudge in textLayout.ts) valid untouched, because the
// punch-in preserves the output frame size exactly.
//
// Still a SINGLE re-encode either way, and audio is still `-c:a copy` — the
// punch segments tile the timeline with no gaps, so duration and frame count
// are unchanged and lip sync holds.
export async function burnSubtitlesAndStripMetadata(
  videoPath: string,
  assPath: string,
  outPath: string,
  punchChain?: string | null
): Promise<void> {
  // ffmpeg's subtitles filter takes its path via a colon-delimited filter
  // string, so Windows-style colons/backslashes and single quotes need
  // escaping. Not a concern on this deploy target (macOS/Linux, posix
  // paths), but escape the characters ffmpeg's filter parser treats
  // specially regardless.
  const escapePath = (p: string) => p.replace(/([:\\'])/g, "\\$1");
  const ass = `ass=${escapePath(assPath)}:fontsdir=${escapePath(FONTS_DIR)}`;

  // Without a punch chain this is byte-for-byte the command that shipped
  // before — one -vf, one filter. With one, the same ass filter is simply
  // chained onto [punched] inside a -filter_complex.
  const filterArgs = punchChain
    ? [
        "-filter_complex",
        `${punchChain};[punched]${ass}[vout]`,
        "-map",
        "[vout]",
        // `?` so a silent source video doesn't fail the whole burn.
        "-map",
        "0:a?",
      ]
    : ["-vf", ass];

  await execFileAsync(
    FFMPEG,
    [
      "-y",
      "-i",
      videoPath,
      ...filterArgs,
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "copy",
      outPath,
    ],
    { timeout: config.captionsFfmpegTimeoutMs, maxBuffer: 1024 * 1024 * 16 }
  );
}
