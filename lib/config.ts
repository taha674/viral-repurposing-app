// Central config + hard caps. Values come from env with safe defaults.
// Hard caps exist to protect against runaway spend against paid APIs
// (project rule: any retry/poll loop must have a hard cap and fail loud).

import path from "node:path";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Single shared password gating the whole app (Railway deploy only —
  // local dev has no gate unless this is set).
  appPassword: process.env.APP_PASSWORD ?? "",

  // Bearer secret for the scheduled-scan cron endpoint (separate from
  // APP_PASSWORD since the cron caller isn't a browser session).
  cronSecret: process.env.CRON_SECRET ?? "",

  // Apify
  apifyToken: process.env.APIFY_TOKEN ?? "",
  apifyActor: process.env.APIFY_INSTAGRAM_ACTOR ?? "apify/instagram-reel-scraper",

  // Gemini (adaptation step)
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  // gemini-2.5-flash is closed to new API keys (404 "no longer available to
  // new users"), so the default is the current flash generation. Pinned rather
  // than gemini-flash-latest: an alias that silently upgrades under a
  // compliance-sensitive prompt is a liability.
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",

  // ElevenLabs (voiceover step)
  elevenlabsKey: process.env.ELEVENLABS_API_KEY ?? "",
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "", // Cyrus v4
  // eleven_v3 supports expressive audio tags (e.g. [excited], [whispers]),
  // which matters here since scripts may contain ElevenLabs audio tags that
  // get passed through unmodified.
  elevenlabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3",
  // eleven_v3 is a slower, higher-latency model than turbo/flash — 30s was
  // cutting off real (non-stuck) generations in production ("This operation
  // was aborted" x2, i.e. both attempts hit the client-side AbortController,
  // not an ElevenLabs-side failure). Raised well above v3's typical
  // generation time. This also matters for spend: aborting a request that
  // already finished generating server-side, then retrying, risks paying
  // for the same script twice — a too-short timeout is a cost bug, not just
  // a reliability one.
  elevenlabsTimeoutMs: intEnv("ELEVENLABS_TIMEOUT_MS", 120_000),
  // Root-level output folder for voiceovers, picked up manually for HeyGen.
  // Default: the Automation project root's reels/ dir (two levels up from webapp/).
  // `?.trim()` matters here: an env var present-but-blank (e.g. `REELS_OUTPUT_DIR=`
  // in .env.local) is "" which `??` would NOT fall back on, silently resolving
  // to a relative path under webapp/ instead of the intended project root.
  reelsOutputDir: process.env.REELS_OUTPUT_DIR?.trim()
    ? process.env.REELS_OUTPUT_DIR
    : path.join(process.cwd(), "..", "..", "reels"),

  // Tunables
  viewThreshold: intEnv("VIEW_THRESHOLD", 1_000_000),
  scanPostsPerAccount: intEnv("SCAN_POSTS_PER_ACCOUNT", 20),
  // Which Apify field counts as "views" for the threshold. Instagram's public
  // reel "views" number maps to plays, so playCount is the default;
  // videoViewCount runs roughly 2x lower on the same reel.
  viewMetric:
    (process.env.VIEW_METRIC as "playCount" | "viewCount") ?? "playCount",

  // Hard caps (never loop silently against a paid API)
  apifyMaxRetries: intEnv("APIFY_MAX_RETRIES", 1),
  geminiMaxRetries: intEnv("GEMINI_MAX_RETRIES", 1),
  adaptMaxOutputTokens: intEnv("ADAPT_MAX_OUTPUT_TOKENS", 2000),
  elevenlabsMaxRetries: intEnv("ELEVENLABS_MAX_RETRIES", 1),
  // Budget guard: block generation instead of spending credits on an
  // oversized script. ~90s of narration has real headroom under this.
  voiceoverMaxChars: intEnv("VOICEOVER_MAX_CHARS", 6_000),

  // Subtitle burn-in (local, no paid API — ffmpeg + a local Whisper model).
  // Model choice: small English-only checkpoint, good enough for clean
  // TTS-quality speech, fast on CPU for reel-length (<2min) clips.
  whisperModel: process.env.WHISPER_MODEL ?? "Xenova/whisper-base.en",
  // Guards against ever hanging on a pathological upload — not a paid-API
  // cap, but the same "never loop/hang silently" principle applies.
  captionsMaxVideoMb: intEnv("CAPTIONS_MAX_VIDEO_MB", 500),
  captionsTranscribeTimeoutMs: intEnv("CAPTIONS_TRANSCRIBE_TIMEOUT_MS", 180_000),
  captionsFfmpegTimeoutMs: intEnv("CAPTIONS_FFMPEG_TIMEOUT_MS", 180_000),
} as const;

export function hasAppPassword(): boolean {
  return config.appPassword.trim().length > 0;
}

export function hasCronSecret(): boolean {
  return config.cronSecret.trim().length > 0;
}

export function hasApify(): boolean {
  return config.apifyToken.trim().length > 0;
}

export function hasGemini(): boolean {
  return config.geminiKey.trim().length > 0;
}

export function hasElevenLabs(): boolean {
  return (
    config.elevenlabsKey.trim().length > 0 &&
    config.elevenlabsVoiceId.trim().length > 0
  );
}
