import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { config } from "./config";
import { getPool } from "./db";
import { listAccounts, markScanned } from "./accounts";
import {
  insertReel,
  getReel,
  setTranscript,
  setAdaptation,
  setVoiceover,
  setCaptions,
  setSourceVideo,
  setSlug,
  findBySlug,
  advanceStatus,
  extractShortcode,
} from "./reels";
import { baseSlug, reelFileName } from "./naming";
import { scanAccount, fetchReel } from "./apify";
import { runAdaptation } from "./gemini";
import { generateVoiceoverWithTimestamps } from "./elevenlabs";
import {
  probeVideo,
  extractAudioForTranscription,
  burnSubtitlesAndStripMetadata,
} from "./ffmpeg";
import { transcribeWavForWordTimings } from "./whisper";
import { alignmentToWordTimings, layoutLines, linesToAss, captionFontSize } from "./captions";
import type { Reel, RedLineFlag } from "./types";

// Returns the reel's slug, minting it if it doesn't have one yet. Minting
// normally happens on accept (acceptReel, below); this fallback only fires
// for reels that reached a later stage before the kanban revamp shipped
// (pre-existing "approved" reels with no slug column value yet).
async function ensureSlug(reel: Reel): Promise<string> {
  if (reel.slug) return reel.slug;
  const base = baseSlug(new Date(), reel.transcript, reel.id);
  const collision = await findBySlug(base, reel.id);
  const slug = collision ? `${base}-${reel.id}` : base;
  await setSlug(reel.id, slug);
  return slug;
}

// --- Transcript retrieval (shared by manual add + scan) ---
// The Apify client already hard-caps retries; here we just translate a failed
// pull into a flagged status rather than looping. Fail loud, never silently.
export async function retrieveTranscript(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  try {
    const scraped = await fetchReel(reel.url);
    if (scraped?.transcript) {
      await setTranscript(reelId, scraped.transcript, "success");
    } else {
      await setTranscript(reelId, reel.transcript, "failed");
    }
  } catch {
    await setTranscript(reelId, reel.transcript, "failed");
  }
  return (await getReel(reelId))!;
}

// --- Accept a scraped reel onto the board (2026-08-23 kanban revamp) ---
// The human-decision gate between "discovered" and "worth adapting". Mints
// the reel's slug here (see lib/naming.ts + ensureSlug above) so every file
// this reel later produces shares one stable name, unaffected by transcript
// edits made afterwards.
export async function acceptReel(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status !== "new" && reel.status !== "transcribed") {
    throw new Error("Reel has already been accepted (or moved further along).");
  }
  await ensureSlug(reel);
  await advanceStatus(reelId, "accepted");
  return (await getReel(reelId))!;
}

// --- Restore a reel from the Rejected or Done tray back onto the board ---
// Reject only ever happens from the Scraped column, and Archive only ever
// happens from the Subtitled column (see app/components/stages), so which
// column to restore into is fully determined by which tray the reel is in —
// no separate "status before rejecting" bookkeeping needed.
export async function restoreReel(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status === "rejected") {
    const target = reel.transcript_status === "success" ? "transcribed" : "new";
    await advanceStatus(reelId, target);
  } else if (reel.status === "archived") {
    await advanceStatus(reelId, "captioned");
  } else {
    throw new Error("Reel is not in the Rejected or Done tray.");
  }
  return (await getReel(reelId))!;
}

// --- Red-line-compliance adaptation (manually triggered) ---
export async function adaptReel(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (!reel.transcript?.trim()) {
    throw new Error(
      "Reel has no transcript yet — retrieve or paste one before adapting."
    );
  }

  const result = await runAdaptation(reel.transcript);
  const validFlags: RedLineFlag[] = ["none", "needs_review", "rejected"];
  const flag = validFlags.includes(result.red_line_flag as RedLineFlag)
    ? (result.red_line_flag as RedLineFlag)
    : "needs_review";

  // Safety check: ensure flag consistency with edits made (§11 fix).
  // If the model made edits but reported flag=none, override to needs_review.
  // This prevents under-flagging where the model fixes a violation but claims
  // no red line was found.
  let finalFlag = flag;
  let finalReason = result.red_line_reason || null;
  if (
    finalFlag === "none" &&
    result.edits_made.length > 0 &&
    result.adapted_script !== reel.transcript
  ) {
    finalFlag = "needs_review";
    finalReason =
      "Adaptation made edits but initially reported no flag. " +
      `Edits: ${result.edits_made.join("; ")}`;
  }

  await setAdaptation(
    reelId,
    result.analysis,
    result.adapted_script,
    finalFlag,
    finalReason
  );
  return (await getReel(reelId))!;
}

// --- ElevenLabs voiceover generation (manually triggered, approved scripts only) ---
// Budget guard runs before any network call — never spend credits on an
// oversized script. Failures are persisted and rethrown: fail loud, never
// loop silently against a paid API (ELEVENLABS_MAX_RETRIES is the hard cap,
// enforced inside elevenlabs.ts).
export async function generateVoiceover(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status !== "approved") {
    throw new Error("Approve the script before generating a voiceover.");
  }
  const script = reel.adapted_script;
  if (!script?.trim()) {
    throw new Error("Reel has no adapted script to generate a voiceover from.");
  }

  if (script.length > config.voiceoverMaxChars) {
    const message = `Script is ${script.length} characters, over the VOICEOVER_MAX_CHARS cap of ${config.voiceoverMaxChars}. Generation blocked to avoid runaway spend.`;
    await setVoiceover(reelId, "failed", null, message);
    throw new Error(message);
  }

  // Recorded before the network call so a page refresh mid-generation shows
  // "generating" instead of silently reverting to the last known status.
  await setVoiceover(reelId, "generating", null, null);

  try {
    const slug = await ensureSlug(reel);
    const { audio, alignment } = await generateVoiceoverWithTimestamps(script);
    const dir = path.join(config.reelsOutputDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, reelFileName(slug, "audio", "mp3"));
    fs.writeFileSync(filePath, audio);
    await setVoiceover(reelId, "success", filePath, null, alignment);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setVoiceover(reelId, "failed", null, message);
    throw err;
  }

  return (await getReel(reelId))!;
}

// --- Save the uploaded HeyGen/edited video (2026-08-23 kanban revamp) ---
// The card reaches the Video column via an explicit "Send to video" step
// (Audio popup, PATCH status -> "video" once voiceover_status is success —
// see app/api/reels/[id]/route.ts) BEFORE any file exists; source_video_path
// staying null is what tells the Video popup to show the upload control
// instead of "Burn subtitles". This function only fills that file in — it
// does not move the status, since the reel is already in the Video column
// by the time an upload is possible.
export async function saveSourceVideo(
  reelId: number,
  videoBuffer: Buffer
): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status !== "video") {
    throw new Error('Send this reel to the "Video" stage before uploading.');
  }

  const slug = await ensureSlug(reel);
  const dir = path.join(config.reelsOutputDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, reelFileName(slug, "source", "mp4"));
  fs.writeFileSync(sourcePath, videoBuffer);

  await setSourceVideo(reelId, sourcePath);

  return (await getReel(reelId))!;
}

// --- Subtitle burn-in on the uploaded video (2026-08-23) ---
// Caption timing prefers the ElevenLabs alignment captured when the
// voiceover was generated (exact, free, no extra step) and falls back to a
// local open-source Whisper transcription of the uploaded video's own audio
// when no alignment is on record (older reels, or a voiceover generated
// before this feature existed). Burning and metadata-stripping happen in
// the same ffmpeg pass — this is the place the pipeline actually produces
// its final video file, so the mandatory strip applies here.
export async function burnCaptions(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status !== "video") {
    throw new Error("Upload the finished video before burning captions.");
  }
  if (reel.voiceover_status !== "success") {
    throw new Error("Generate the voiceover before burning captions.");
  }
  if (!reel.source_video_path) {
    throw new Error("No uploaded video found — upload one first.");
  }

  await setCaptions(reelId, "processing", null, null);

  const slug = await ensureSlug(reel);
  const dir = path.join(config.reelsOutputDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = reel.source_video_path;
  const wavPath = path.join(dir, `${slug}-extract.wav`);
  const assPath = path.join(dir, `${slug}-captions.ass`);
  const outPath = path.join(dir, reelFileName(slug, "subtitled", "mp4"));

  try {
    const probe = await probeVideo(sourcePath);

    const words = reel.voiceover_alignment
      ? alignmentToWordTimings(reel.voiceover_alignment)
      : await (async () => {
          await extractAudioForTranscription(sourcePath, wavPath);
          return transcribeWavForWordTimings(wavPath);
        })();

    if (words.length === 0) {
      throw new Error("No word timings available to caption this video.");
    }

    const fontSize = captionFontSize(probe.height);
    const lines = layoutLines(words, probe.width, fontSize);
    fs.writeFileSync(assPath, linesToAss(lines, probe.width, probe.height));
    await burnSubtitlesAndStripMetadata(sourcePath, assPath, outPath);

    await setCaptions(reelId, "success", outPath, null);
    await advanceStatus(reelId, "captioned");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setCaptions(reelId, "failed", null, message);
    throw err;
  } finally {
    // Intermediate files aren't needed once burned; the extracted audio and
    // ASS subtitle file would otherwise pile up in the reel folder. The
    // uploaded source video is NOT deleted — a re-burn (e.g. after a failed
    // attempt) depends on it still being there.
    for (const f of [wavPath, assPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  return (await getReel(reelId))!;
}

// --- Reveal the captioned video in Finder (local machine only) ---
export async function revealCaptionedVideo(reelId: number): Promise<void> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.captions_status !== "success" || !reel.captions_video_path) {
    throw new Error("No captioned video to reveal yet — burn captions first.");
  }
  if (!fs.existsSync(reel.captions_video_path)) {
    throw new Error(`Captioned video no longer exists at ${reel.captions_video_path}.`);
  }
  await execFileAsync("open", ["-R", reel.captions_video_path]);
}

// --- Reveal the generated voiceover in Finder (local machine only) ---
export async function revealVoiceover(reelId: number): Promise<void> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.voiceover_status !== "success" || !reel.voiceover_path) {
    throw new Error("No voiceover file to reveal yet — generate one first.");
  }
  if (!fs.existsSync(reel.voiceover_path)) {
    throw new Error(`Voiceover file no longer exists at ${reel.voiceover_path}.`);
  }
  await execFileAsync("open", ["-R", reel.voiceover_path]);
}

// --- Manual shortlist add ---
export interface ManualAddResult {
  reel: Reel;
  qualifies: boolean;
  forced: boolean;
  alreadyExisted: boolean;
}

export async function addManualReel(
  url: string,
  force: boolean
): Promise<ManualAddResult> {
  const shortcode = extractShortcode(url);
  // Single call: metadata + transcript (it's a chosen reel, so pull both).
  const scraped = await fetchReel(url);
  const views = scraped?.views ?? null;
  const qualifies = views !== null && views >= config.viewThreshold;

  if (!qualifies && !force) {
    // Don't persist below-threshold reels unless the operator forces it.
    return {
      reel: {
        id: 0,
        account_id: null,
        platform: "instagram",
        url,
        shortcode: scraped?.shortcode ?? shortcode,
        views,
        date_found: "",
        source: "manual",
        transcript: null,
        transcript_status: "pending",
        analysis: null,
        adapted_script: null,
        red_line_flag: "none",
        red_line_reason: null,
        voiceover_status: "none",
        voiceover_path: null,
        voiceover_error: null,
        voiceover_alignment: null,
        captions_status: "none",
        captions_video_path: null,
        captions_error: null,
        source_video_path: null,
        slug: null,
        status: "new",
        created_at: "",
        updated_at: "",
      },
      qualifies: false,
      forced: false,
      alreadyExisted: false,
    };
  }

  // insertReel dedupes on shortcode and returns the existing row if present.
  const reel = await insertReel({
    url,
    shortcode: scraped?.shortcode ?? shortcode,
    views,
    source: "manual",
    transcript: scraped?.transcript ?? null,
    transcript_status: scraped?.transcript ? "success" : "failed",
  });

  return {
    reel,
    qualifies,
    forced: !qualifies && force,
    alreadyExisted: false,
  };
}

// --- Weekly scan ---
export interface ScanSummary {
  scannedAccounts: number;
  newReels: number;
  errors: number;
}

export async function runScan(): Promise<ScanSummary> {
  const pool = await getPool();
  const logScan = (
    accountId: number,
    handle: string,
    status: string,
    message: string,
    reelsFound: number
  ) =>
    pool.query(
      `INSERT INTO scan_logs (account_id, handle, status, message, reels_found)
       VALUES ($1, $2, $3, $4, $5)`,
      [accountId, handle, status, message, reelsFound]
    );

  const accounts = (await listAccounts()).filter((a) => a.active === 1);

  let newReels = 0;
  let errors = 0;

  for (const account of accounts) {
    try {
      const scraped = await scanAccount(account.handle);
      const qualifying = scraped.filter(
        (r) => r.views !== null && r.views >= config.viewThreshold && r.url
      );

      let foundForAccount = 0;
      for (const r of qualifying) {
        const reel = await insertReel({
          account_id: account.id,
          url: r.url,
          shortcode: r.shortcode,
          views: r.views,
          source: "weekly_scan",
        });
        // insertReel dedupes: only pull transcript for genuinely new reels
        // that don't yet have one (avoids paying the transcript charge twice).
        if (reel.transcript_status === "pending" && !reel.transcript) {
          foundForAccount += 1;
          await retrieveTranscript(reel.id);
        }
      }

      await markScanned(account.id, foundForAccount);
      newReels += foundForAccount;
      await logScan(
        account.id,
        account.handle,
        "ok",
        `${qualifying.length} qualifying, ${foundForAccount} new`,
        foundForAccount
      );
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await logScan(account.id, account.handle, "error", message, 0);
    }
  }

  return { scannedAccounts: accounts.length, newReels, errors };
}
