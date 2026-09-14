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

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
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
  // Hashtag discovery actor (2026-08-24) — separate actor from the per-account
  // reel scraper above. Input/output schema confirmed against Apify's published
  // docs (apify.com/apify/instagram-hashtag-scraper), NOT live-verified against
  // a real run the way apifyActor was — see the module-level note in apify.ts.
  apifyHashtagActor:
    process.env.APIFY_INSTAGRAM_HASHTAG_ACTOR ?? "apify/instagram-hashtag-scraper",

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
  // No longer applied to the account scan (2026-09-14) — that scan now
  // qualifies purely on view-rank (highest first), not a hard floor, so a
  // quiet week doesn't come back empty. Still used by addManualReel (the
  // "paste a URL" shortlist add) and the hashtag scan, where a floor still
  // makes sense.
  viewThreshold: intEnv("VIEW_THRESHOLD", 500_000),
  // Posts pulled per account per scan sweep — high enough to approximate
  // "the account's available history" rather than just its most-recent
  // handful, while still bounded (project rule: no unbounded pull against a
  // paid API). This is metadata-only (no transcript charge), so the cost of
  // a high limit is low; SCAN_BATCH_PER_ACCOUNT below is what actually
  // rations the expensive per-reel work (transcript pull).
  scanPostsPerAccount: intEnv("SCAN_POSTS_PER_ACCOUNT", 200),
  // How many NEW reels (by view rank, highest first) each account gives up
  // per round when the scan cycles through accounts (see
  // scanMinNewReelsPerRun below) — the "2 at a time" increment. Reels
  // already on record (by shortcode) don't count against this, so a given
  // account's own pace across scan runs still advances 2-at-a-time down its
  // ranked list even though a single run may take more than one round's
  // worth from it to hit the run-wide floor.
  scanBatchPerAccount: intEnv("SCAN_BATCH_PER_ACCOUNT", 2),
  // Floor on total NEW reels the account scan tries to gather in one run,
  // across all active accounts combined. Round-robins accounts in
  // scanBatchPerAccount-sized chunks (2 from account A, 2 from account B,
  // ... then back to A for the next 2, etc.) until this many new reels have
  // been found or every account's ranked candidate list is exhausted —
  // whichever comes first, so it's a target, not a promise, and it never
  // loops once accounts genuinely have nothing left to give. Each admitted
  // reel costs a paid Apify transcript pull, so this doubles as the hard cap
  // on that spend for one scan run.
  scanMinNewReelsPerRun: intEnv("SCAN_MIN_NEW_REELS_PER_RUN", 15),
  // Top reels pulled per hashtag during a hashtag scan (before the view-count
  // and talking-head filters run) — separate knob since hashtag volume/noise
  // is very different from a tracked account's own post history.
  scanPostsPerHashtag: intEnv("SCAN_POSTS_PER_HASHTAG", 30),
  // Which Apify field counts as "views" for the threshold. Instagram's public
  // reel "views" number maps to plays, so playCount is the default;
  // videoViewCount runs roughly 2x lower on the same reel.
  viewMetric:
    (process.env.VIEW_METRIC as "playCount" | "viewCount") ?? "playCount",

  // Hard caps (never loop silently against a paid API)
  apifyMaxRetries: intEnv("APIFY_MAX_RETRIES", 1),
  geminiMaxRetries: intEnv("GEMINI_MAX_RETRIES", 1),
  adaptMaxOutputTokens: intEnv("ADAPT_MAX_OUTPUT_TOKENS", 2000),
  // Separate cap from the adaptation call, deliberately: the publish pack is
  // a second, independent Gemini call with its own prompt and schema, and
  // sharing a budget would mean tuning one to fit the other. Hitting the cap
  // throws (MAX_TOKENS is fail-loud in gemini.ts) rather than writing a
  // half-built pack.
  publishPackMaxOutputTokens: intEnv("PUBLISH_PACK_MAX_OUTPUT_TOKENS", 1800),
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

  // Punch-in zoom (2026-09-12). Re-framing steps burned in the same pass as
  // the subtitles, BEFORE them in the filter chain so captions don't scale.
  // Set PUNCH_IN=off to fall back to the plain subtitle burn.
  punchInEnabled: (process.env.PUNCH_IN ?? "on").toLowerCase() !== "off",
  // Zoom added per level, as a fraction of the base frame. Landed by
  // bracketing: 0.08 read as too timid (re-frames landed between two
  // near-identical framings, so nothing registered as a cut), 0.11 read as
  // too aggressive. 0.09 puts the top of the ladder at 1.27x and the mean
  // zoom near the midpoint of those two judgements. Resolution is not the
  // binding constraint here — at 1.27x you still keep 79% of the source's
  // linear detail.
  punchInStep: floatEnv("PUNCH_IN_STEP", 0.09),
  // Ceiling on the number of steps. Every climb ends at this level; what
  // varies is how many punches it takes to get there. Three levels read as
  // too much — the successive steps landed 1.1-1.5s apart and the top of the
  // ladder was tighter than the footage wanted — so a cycle is now at most
  // two punches, topping out at 1.18x.
  punchInMaxLevel: intEnv("PUNCH_IN_MAX_LEVEL", 2),
  // A re-frame holds at least this long, and at least until the caption
  // it landed on finishes — whichever is later. Stops a climb from
  // stepping again while the same words are still on screen.
  punchInMinHoldSeconds: floatEnv("PUNCH_IN_MIN_HOLD", 0.5),
  // A word gap this long counts as a phrase break. Derived from WORD
  // timings, not caption-line boundaries: layoutLines breaks on word count
  // and width far more often than on pauses, so its line gaps are mostly
  // zero and carry no rhythm. Word gaps carry the real delivery.
  punchInMinGapSeconds: floatEnv("PUNCH_IN_MIN_GAP", 0.10),
  // Beat boundaries are picked relative to THIS video's own pause
  // distribution — an absolute seconds threshold does not survive contact
  // with TTS audio, where every pause lands in a narrow 0.2-0.6s band.
  punchInBoundaryPercentile: floatEnv("PUNCH_IN_BOUNDARY_PCTL", 0.50),
  // Beats must be long enough to HOLD two or three phrase breaks — that's
  // what produces varied climb depths instead of a uniform sawtooth.
  //
  // CALIBRATION NOTE: these three numbers were tuned against ONE 60s avatar
  // render, by sweeping and scoring the result on depth variety (are all
  // three depths used, and how often do neighbouring cycles match?). The
  // STRUCTURE generalises — boundaries are relative to each video's own pause
  // distribution, and depth comes from beat content — but these absolute
  // values are a fit to a sample of one. Re-check them against a reel with a
  // noticeably different speaking rate before trusting them broadly.
  punchInMinBeatSeconds: floatEnv("PUNCH_IN_MIN_BEAT", 4.5),
  punchInMaxBeatSeconds: floatEnv("PUNCH_IN_MAX_BEAT", 8.0),
  captionsTranscribeTimeoutMs: intEnv("CAPTIONS_TRANSCRIBE_TIMEOUT_MS", 180_000),
  captionsFfmpegTimeoutMs: intEnv("CAPTIONS_FFMPEG_TIMEOUT_MS", 180_000),

  // Auto-purge threshold (2026-09-13). Checked before every write that grows
  // REELS_OUTPUT_DIR (voiceover, source upload, burn) — see
  // service.ts#autoPurgeIfOverThreshold. Deliberately narrow: crossing this
  // only reclaims archived-reel folders and already-burned sources (the same
  // two provably-dead categories scripts/purge-volume.mjs targets), never
  // active or undownloaded work. If usage stays over the threshold after a
  // purge, that's a signal to resize the volume or archive/burn more reels —
  // not a reason to delete anything else.
  volumePurgeThresholdMb: intEnv("VOLUME_PURGE_THRESHOLD_MB", 500),
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
