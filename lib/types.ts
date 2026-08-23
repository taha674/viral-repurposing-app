// Shared domain types. Mirrors the data model in ../reference-inputs.md / PRD §6.
// Platform is instagram-only for the MVP (TikTok deferred).

export type Platform = "instagram";
export type ReelSource = "weekly_scan" | "manual";
export type TranscriptStatus = "pending" | "success" | "failed";
export type RedLineFlag = "none" | "needs_review" | "rejected";
export type VoiceoverStatus = "none" | "generating" | "success" | "failed";
export type CaptionsStatus = "none" | "processing" | "success" | "failed";

// Character-level timing ElevenLabs returns from the with-timestamps
// endpoint, alongside the audio, at no extra cost. Preferred source for
// caption timing whenever a reel has it — exact, no transcription needed.
export interface VoiceoverAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
export type ReelStatus =
  | "new"
  | "transcribed"
  | "adapted"
  | "approved"
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
  status: ReelStatus;
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
