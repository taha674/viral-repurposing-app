// Shared domain types. Mirrors the data model in ../reference-inputs.md / PRD §6.
// Platform is instagram-only for the MVP (TikTok deferred).

export type Platform = "instagram";
export type ReelSource = "weekly_scan" | "manual" | "hashtag_scan";
export type TranscriptStatus = "pending" | "success" | "failed";
export type RedLineFlag = "none" | "needs_review" | "rejected";
export type VoiceoverStatus = "none" | "generating" | "success" | "failed";
export type CaptionsStatus = "none" | "processing" | "success" | "failed";
export type PublishPackStatus = "none" | "generating" | "success" | "failed";

// How this reel should carry its text hook on the cover frame. Instagram
// lets you pick any frame of the reel as the cover, so a frame that already
// has a burnt-in subtitle line on it IS a text hook — the choice is whether
// that's enough, whether a separate text sticker does it better, or whether
// the two carry different halves of the hook.
export type HookMode = "subtitle_only" | "sticker_only" | "subtitle_plus_sticker";

// One candidate cover text, with the reasoning that makes it reviewable.
// `why_not_clickbait` is not decoration: it's the satisfaction test ("will
// someone who watches feel this was honest?"), which is the same judgement
// as red lines 6 and 9, written down so the operator can check it.
export interface ThumbnailOption {
  text: string; // 2–5 words, uppercase
  technique: string; // which curiosity mechanism it uses
  why_not_clickbait: string; // how the video pays it off
}

// Suggested, human-editable post metadata. Never posted by this app — the
// operator edits and chooses (see the caption/hashtag rule in CLAUDE.md).
export interface PublishPack {
  caption: string;
  caption_rationale: string;
  hashtags: string[]; // without the leading '#'
  hashtags_rejected: string[]; // source tags deliberately dropped, reason inline
  thumbnail_text: ThumbnailOption[];
  hook_mode: HookMode;
  hook_mode_reason: string;
  // Timestamp of the frame to use as the cover, chosen from the real
  // subtitle lines we computed and sent. Null when hook_mode is
  // "sticker_only", or when the reel has no word timings yet.
  cover_frame_seconds: number | null;
  cover_frame_line: string | null;
  red_line_flag: RedLineFlag;
  red_line_reason: string;
}

// Character-level timing ElevenLabs returns from the with-timestamps
// endpoint, alongside the audio, at no extra cost. Preferred source for
// caption timing whenever a reel has it — exact, no transcription needed.
export interface VoiceoverAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
// Ordered along the board's columns (lib/stages.ts maps these to columns).
// "accepted", "video", and "captioned" were added with the kanban revamp:
// the pipeline always had those beats, the old single-page UI just never
// gave them a status of their own.
export type ReelStatus =
  | "new" // scraped, not yet triaged
  | "transcribed" // scraped + transcript on record, still not triaged
  | "accepted" // human accepted it onto the board
  | "adapted" // adaptation has run, awaiting approval
  | "approved" // script approved, voiceover stage
  | "video" // HeyGen video uploaded, awaiting subtitle burn
  | "captioned" // subtitles burned + metadata stripped — finished file
  | "archived"
  | "rejected";

export interface TrackedAccount {
  id: number;
  platform: Platform;
  handle: string;
  active: number; // sqlite: 0/1
  last_scanned_at: string | null;
  reels_found_count: number;
  created_at: string;
}

// Hashtag-based discovery (2026-08-24): a second discovery mode alongside
// tracked accounts. Same lifecycle shape (active/pause, last scan, running
// found-count) so it reuses the account scan's UI and scan patterns.
export interface TrackedHashtag {
  id: number;
  tag: string; // stored without the leading '#'
  active: number; // 0/1, mirrors TrackedAccount
  last_scanned_at: string | null;
  reels_found_count: number;
  created_at: string;
}

// Structural breakdown of the SOURCE reel (analysis), matching the CSV format.
export interface Analysis {
  hook: string;
  reframe: string;
  mechanism: string;
  philosophical_close: string;
  cta: string;
  top_psychological_triggers: string[];
}

export interface Reel {
  id: number;
  account_id: number | null;
  // Which tracked hashtag surfaced this reel, when source is "hashtag_scan".
  // Null for account-scan and manual reels.
  hashtag_id: number | null;
  platform: Platform;
  url: string;
  shortcode: string | null; // used for dedupe
  views: number | null;
  date_found: string;
  source: ReelSource;
  transcript: string | null;
  transcript_status: TranscriptStatus;
  analysis: string | null; // JSON-encoded Analysis
  adapted_script: string | null; // minimally-edited, red-line-compliant script
  red_line_flag: RedLineFlag;
  red_line_reason: string | null;
  voiceover_status: VoiceoverStatus;
  voiceover_path: string | null;
  voiceover_error: string | null;
  voiceover_alignment: VoiceoverAlignment | null;
  captions_status: CaptionsStatus;
  captions_video_path: string | null;
  captions_error: string | null;
  // The source post's own caption and hashtags, captured from the scrape.
  // Null on every reel scraped before 2026-09-12 — there is no backfill, so
  // consumers must handle their absence rather than assume them.
  source_caption: string | null;
  source_hashtags: string[] | null;
  // Suggested caption / hashtags / cover text. Manually triggered and
  // re-runnable, so it always reflects the current adapted_script.
  publish_pack: PublishPack | null;
  publish_pack_status: PublishPackStatus;
  publish_pack_error: string | null;
  // The finished HeyGen/edited video the operator uploads before the burn.
  // Presence is the "video uploaded" signal — there is no separate status.
  source_video_path: string | null;
  // Stable file-naming stem, minted once on accept. See lib/naming.ts.
  slug: string | null;
  status: ReelStatus;
  // Status this reel was in right before it was rejected — lets restore put
  // it back where it came from instead of always assuming Scraped. Null for
  // reels that have never been rejected.
  previous_status: ReelStatus | null;
  // Small preview image captured from the scrape, if the actor returned one.
  // Instagram's CDN URLs expire, so treat as best-effort — may 404.
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanLog {
  id: number;
  run_at: string;
  account_id: number | null;
  handle: string;
  status: "ok" | "error";
  message: string;
  reels_found: number;
}

// The board renders every reel at once, so it fetches a trimmed row: no
// transcript, no analysis JSON, and above all no voiceover_alignment (three
// parallel arrays with one entry per character — by far the largest column).
// adapted_script stays because the Adaptation and Audio cards show an
// excerpt of it. source_caption and publish_pack are trimmed for the same
// reason — both are prose-sized and only the stage popup renders them.
// publish_pack_status stays, so a card can show a badge without the payload.
// The stage popup fetches the full Reel via GET /api/reels/[id].
export type ReelSummary = Omit<
  Reel,
  | "transcript"
  | "analysis"
  | "voiceover_alignment"
  | "source_caption"
  | "publish_pack"
> & {
  // Kept so cards can still show a transcript badge/excerpt without shipping
  // the whole transcript to the browser.
  has_transcript: boolean;
  transcript_excerpt: string | null;
};
