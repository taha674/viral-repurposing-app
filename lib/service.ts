import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { config } from "./config";
import { getPool } from "./db";
import { listAccounts, markScanned } from "./accounts";
import { listHashtags, markHashtagScanned } from "./hashtags";
import {
  insertReel,
  getReel,
  findByShortcode,
  setTranscript,
  setAdaptation,
  setVoiceover,
  setCaptions,
  setPublishPack,
  setSourceVideo,
  clearMediaPaths,
  clearSourceVideo,
  setSlug,
  findBySlug,
  advanceStatus,
  extractShortcode,
  parseAnalysis,
} from "./reels";
import { baseSlug, reelFileName } from "./naming";
import { scanAccount, scanHashtag, fetchReel, captionBody } from "./apify";
import { runAdaptation, classifyTalkingHead, runPublishPack } from "./gemini";
import type { CoverCandidate } from "./publishPrompt";
import { generateVoiceoverWithTimestamps } from "./elevenlabs";
import {
  probeVideo,
  extractAudioForTranscription,
  burnSubtitlesAndStripMetadata,
} from "./ffmpeg";
import { transcribeWavForWordTimings } from "./whisper";
import { purgeReelFiles, deleteFileIfExists, outputDirSizeBytes, formatBytes } from "./retention";
import { alignmentToWordTimings, layoutLines, linesToAss, captionFontSize } from "./captions";
import { buildPunchSchedule, punchInFilter } from "./punchIn";
import type { Reel, RedLineFlag, PublishPack } from "./types";

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
    // The source caption and hashtags ride along on the same response we're
    // already paying for, so they're backfilled here too — this is also the
    // path every account-scan qualifier takes, so new reels get them whether
    // they arrive by scan or by manual add. setTranscript never overwrites
    // an existing value with null, so a field-less re-pull is harmless.
    const extras = {
      thumbnailUrl: scraped?.thumbnailUrl,
      sourceCaption: scraped?.caption,
      sourceHashtags: scraped?.hashtags,
    };
    if (scraped?.transcript) {
      await setTranscript(reelId, scraped.transcript, "success", extras);
    } else {
      await setTranscript(reelId, reel.transcript, "failed", extras);
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
// Reject can now happen from any column (2026-08-24), so restoring returns
// the reel to previous_status — the column it was actually in right before
// it got rejected (recorded by setStatus, see lib/reels.ts). Falls back to
// the old Scraped-only inference for reels rejected before that column
// existed. Archive only ever happens from the Subtitled column, so that
// side stays a fixed target.
export async function restoreReel(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status === "rejected") {
    const target =
      reel.previous_status ??
      (reel.transcript_status === "success" ? "transcribed" : "new");
    await advanceStatus(reelId, target);
  } else if (reel.status === "archived") {
    // Archiving purges the reel's whole folder from the volume (see
    // archiveReel below), so there is no captioned file to come back to —
    // returning this reel to the Subtitled column would show download and
    // stream controls for a video that no longer exists. The adapted
    // script is DB text and survives the purge, so the meaningful restore
    // target is the Audio column: the operator re-generates the voiceover
    // (an explicit, manually triggered paid call) and redoes the video.
    await advanceStatus(reelId, "approved");
  } else {
    throw new Error("Reel is not in the Rejected or Done tray.");
  }
  return (await getReel(reelId))!;
}

// --- Automatic threshold-triggered purge (2026-09-13) ---
// Archiving (below) and the post-burn source delete (see burnCaptions)
// only reclaim disk when the operator takes those actions. This is the
// self-healing backstop: checked before every write that grows
// REELS_OUTPUT_DIR, it reclaims the SAME two provably-dead categories the
// manual scripts/purge-volume.mjs targets —  archived reels' whole folders,
// and already-burned reels' now-unneeded source videos — whenever total
// usage crosses config.volumePurgeThresholdMb.
//
// Deliberately not a wipe. An earlier version of this ask was "just
// shutil.rmtree the whole reels directory past N MB" — that would delete a
// mid-upload source, a not-yet-burned video, or a captioned output the
// operator hasn't downloaded yet, none of which are safe to lose on a size
// timer. If usage is still over the threshold after this runs, the
// remainder is active/undelivered work by construction, and the honest
// next step is resizing the volume or archiving/burning more reels — not
// a deeper delete.
export type AutoPurgeResult = {
  ranPurge: boolean;
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
  deleted: { kind: "archived" | "burned-source"; reelId: number; label: string }[];
  stillOverThreshold: boolean;
};

// Every write path below calls this before it writes. Coalescing concurrent
// callers into one in-flight pass avoids two uploads racing to delete the
// same archived folder or burned source.
let autoPurgeInFlight: Promise<AutoPurgeResult> | null = null;

export async function autoPurgeIfOverThreshold(): Promise<AutoPurgeResult> {
  if (!autoPurgeInFlight) {
    autoPurgeInFlight = runAutoPurge().finally(() => {
      autoPurgeInFlight = null;
    });
  }
  return autoPurgeInFlight;
}

async function runAutoPurge(): Promise<AutoPurgeResult> {
  const thresholdBytes = config.volumePurgeThresholdMb * 1024 * 1024;
  const beforeBytes = outputDirSizeBytes();
  if (beforeBytes <= thresholdBytes) {
    return {
      ranPurge: false,
      beforeBytes,
      afterBytes: beforeBytes,
      freedBytes: 0,
      deleted: [],
      stillOverThreshold: false,
    };
  }

  const pool = await getPool();
  const deleted: AutoPurgeResult["deleted"] = [];
  let freedBytes = 0;

  const { rows: archivedRows } = await pool.query<{ id: number; slug: string }>(
    "SELECT id, slug FROM reels WHERE status = 'archived' AND slug IS NOT NULL"
  );
  for (const row of archivedRows) {
    const purged = purgeReelFiles(row.slug);
    if (purged.existed) {
      freedBytes += purged.bytes;
      deleted.push({ kind: "archived", reelId: row.id, label: row.slug });
      await clearMediaPaths(row.id);
    }
  }

  const { rows: burnedRows } = await pool.query<{
    id: number;
    source_video_path: string;
  }>(
    `SELECT id, source_video_path FROM reels
       WHERE captions_status = 'success' AND source_video_path IS NOT NULL
         AND status != 'archived'`
  );
  for (const row of burnedRows) {
    const bytes = deleteFileIfExists(row.source_video_path);
    if (bytes > 0) {
      freedBytes += bytes;
      deleted.push({
        kind: "burned-source",
        reelId: row.id,
        label: path.basename(row.source_video_path),
      });
      await clearSourceVideo(row.id);
    }
  }

  const afterBytes = beforeBytes - freedBytes;
  const stillOverThreshold = afterBytes > thresholdBytes;

  console.log(
    `[auto-purge] volume was ${formatBytes(beforeBytes)}, over the ` +
      `${config.volumePurgeThresholdMb}MB threshold — freed ${formatBytes(freedBytes)} ` +
      `from ${deleted.length} item(s), now ${formatBytes(afterBytes)}.` +
      (stillOverThreshold
        ? " Still over threshold — remaining usage is active/undelivered " +
          "work; resize the volume or archive/burn more reels."
        : "")
  );

  return { ranPurge: true, beforeBytes, afterBytes, freedBytes, deleted, stillOverThreshold };
}

// A purge failure should never block the actual paid/user-triggered action
// it's guarding — it's maintenance, not a precondition. Every call site
// below uses this wrapper instead of calling autoPurgeIfOverThreshold
// directly, so a DB hiccup during the size check can't turn into a failed
// voiceover/upload/burn.
async function tryAutoPurge(context: string): Promise<void> {
  try {
    await autoPurgeIfOverThreshold();
  } catch (err) {
    console.warn(
      `[auto-purge] check failed during ${context}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// --- Archive a finished reel, reclaiming its disk (2026-09-12) ---
// Archive is terminal for files: it deletes the reel's entire slug folder
// from REELS_OUTPUT_DIR. This is the pipeline's only mechanism for
// reclaiming volume space on operator action — the automatic backstop above
// covers the rest — without either, every processed reel left ~63MB
// behind permanently and the Railway volume filled up, failing writes with
// ENOSPC.
//
// The delete happens BEFORE the status move, deliberately: if the purge
// throws (permissions, a volume that has gone read-only), the reel stays in
// the Subtitled column with its files intact and the operator sees the
// error, rather than landing in Done having silently kept the disk.
export async function archiveReel(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);

  const purged = purgeReelFiles(reel.slug);
  if (purged.existed) {
    // Logged, not silent: this removed the operator's finished video.
    console.log(
      `[archive] reel ${reelId} (${reel.slug}) — deleted ${purged.files.length} file(s), ` +
        `freed ${formatBytes(purged.bytes)} from ${purged.dir}`
    );
  }
  await clearMediaPaths(reelId);
  await advanceStatus(reelId, "archived");

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

// --- Publish pack: caption / hashtags / cover text hook (2026-09-12) ---

// Instagram lets the operator pick any frame as the reel's cover, and this
// pipeline burns word-by-word subtitles in — so a frame carrying a subtitle
// line IS a text hook. These are the real lines from the start of the video,
// each timed to the moment it's fully drawn, computed from the same word
// timings the burn itself uses (captions.ts). Handing the model a concrete
// list to choose from by index is what makes the "which frame" answer real
// rather than a plausible-sounding invention.
const COVER_WINDOW_SECONDS = 8;
// Frame geometry when the video hasn't been uploaded yet. The pack is
// generated at the Adaptation stage, long before the HeyGen render exists,
// and layoutLines needs a width to break lines on — 1080x1920 is what HeyGen
// outputs and what every reel here ends up being. Only affects where lines
// break, never their timing.
const ASSUMED_WIDTH = 1080;
const ASSUMED_HEIGHT = 1920;

async function coverCandidates(reel: Reel): Promise<CoverCandidate[]> {
  if (!reel.voiceover_alignment) return [];
  const words = alignmentToWordTimings(reel.voiceover_alignment);
  if (words.length === 0) return [];

  // Use the real frame size once the video is on disk so the candidate lines
  // break exactly the way the burnt-in ones will; fall back to the assumed
  // vertical frame before the upload exists.
  let width = ASSUMED_WIDTH;
  let height = ASSUMED_HEIGHT;
  if (reel.source_video_path && fs.existsSync(reel.source_video_path)) {
    try {
      const probe = await probeVideo(reel.source_video_path);
      width = probe.width;
      height = probe.height;
    } catch {
      // A probe failure is not worth failing the pack over — the assumed
      // frame still produces usable line breaks and identical timings.
    }
  }

  const lines = layoutLines(words, width, captionFontSize(height));
  return lines
    .filter((l) => l.start < COVER_WINDOW_SECONDS)
    .map((l) => ({
      // Mid-hold rather than the line's start: at `start` the first word has
      // only just appeared, so a frame grabbed there can catch the phrase
      // half-drawn. Halfway through it is reliably complete.
      seconds: Number((l.start + (l.end - l.start) / 2).toFixed(2)),
      text: l.text,
    }));
}

// Manually triggered and freely re-runnable. Re-runnable is the point: the
// operator routinely hand-edits adapted_script at the Adaptation stage, and a
// pack generated before that edit describes a script that no longer exists.
// Being a button rather than a step of adaptReel also keeps a paid call from
// ever firing unattended inside the scan loop.
export async function generatePublishPack(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  const script = reel.adapted_script;
  if (!script?.trim()) {
    throw new Error(
      "Run the adaptation first — the publish pack is written from the adapted script."
    );
  }

  // Recorded before the network call so a refresh mid-run shows "generating"
  // rather than silently reverting to the previous pack.
  await setPublishPack(reelId, "generating", null, null);

  try {
    const candidates = await coverCandidates(reel);
    const result = await runPublishPack({
      adaptedScript: script,
      analysis: parseAnalysis(reel),
      sourceCaptionBody: captionBody(reel.source_caption),
      sourceHashtags: reel.source_hashtags ?? [],
      coverCandidates: candidates,
    });

    // Resolve the chosen index against the list we actually sent. An
    // out-of-range index becomes "no cover frame" rather than a wrong one —
    // the whole reason the model picks by index is that it can't then name a
    // frame that doesn't exist.
    const idx = result.cover_frame_index;
    const chosen =
      Number.isInteger(idx) && idx >= 0 && idx < candidates.length
        ? candidates[idx]
        : null;

    const validFlags: RedLineFlag[] = ["none", "needs_review", "rejected"];
    const flag = validFlags.includes(result.red_line_flag)
      ? result.red_line_flag
      : "needs_review";

    const pack: PublishPack = {
      caption: result.caption,
      caption_rationale: result.caption_rationale,
      // Normalize away any '#' the model prefixed despite the instruction,
      // and drop empties — the UI renders the '#' itself.
      hashtags: (result.hashtags ?? [])
        .map((t) => t.replace(/^#+/, "").trim())
        .filter(Boolean),
      hashtags_rejected: result.hashtags_rejected ?? [],
      thumbnail_text: result.thumbnail_text ?? [],
      hook_mode: result.hook_mode,
      hook_mode_reason: result.hook_mode_reason,
      // A sticker-only hook has no cover line by definition, so don't carry
      // one even if an index came back.
      cover_frame_seconds:
        result.hook_mode === "sticker_only" ? null : (chosen?.seconds ?? null),
      cover_frame_line:
        result.hook_mode === "sticker_only" ? null : (chosen?.text ?? null),
      red_line_flag: flag,
      red_line_reason: result.red_line_reason ?? "",
    };

    await setPublishPack(reelId, "success", pack, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setPublishPack(reelId, "failed", null, message);
    throw err;
  }

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

  // Checked before spending on ElevenLabs, not just before the write below —
  // no point paying for a generation that then fails on disk.
  await tryAutoPurge("generateVoiceover");

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

  await tryAutoPurge("saveSourceVideo");

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

  await tryAutoPurge("burnCaptions");

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

    // Punch-in re-framing, scheduled off the SAME phrase lines the captions
    // use — so every zoom lands exactly on a subtitle change, which is what
    // the reference reels do. Applied before the ASS burn in one pass (see
    // burnSubtitlesAndStripMetadata): zooming after would scale the
    // subtitles along with the frame.
    let punchChain: string | null = null;
    if (config.punchInEnabled) {
      const opts = {
        step: config.punchInStep,
        maxLevel: config.punchInMaxLevel,
        minGapSeconds: config.punchInMinGapSeconds,
        boundaryPercentile: config.punchInBoundaryPercentile,
        minBeatSeconds: config.punchInMinBeatSeconds,
        maxBeatSeconds: config.punchInMaxBeatSeconds,
      };
      const punches = buildPunchSchedule(words, lines, probe.durationSeconds, opts);
      punchChain = punchInFilter(
        punches,
        probe.width,
        probe.height,
        probe.durationSeconds,
        opts
      );
    }

    await burnSubtitlesAndStripMetadata(sourcePath, assPath, outPath, punchChain);

    await setCaptions(reelId, "success", outPath, null);
    await advanceStatus(reelId, "captioned");

    // Reclaim the uploaded source now that the burn has succeeded. The
    // source is ~44MB of a reel's ~63MB footprint and, once burned, is
    // needed only for a re-burn — which the operator can still do by
    // re-uploading. Disk is the binding constraint on the Railway volume
    // (it filled up and started failing writes with ENOSPC), so the
    // trade-off was made deliberately in favour of space.
    //
    // Deleted only after setCaptions("success") lands: if the burn threw,
    // the catch below runs instead and the source survives for a retry.
    // Same deleteFileIfExists() the auto-purge backstop uses for this exact
    // category (see autoPurgeIfOverThreshold) — one path-safety check, not
    // two copies of it.
    try {
      const freed = deleteFileIfExists(sourcePath);
      if (freed > 0) {
        await clearSourceVideo(reelId);
        console.log(
          `[burn] reel ${reelId} (${slug}) — deleted source video, freed ${formatBytes(freed)}`
        );
      }
    } catch (cleanupErr) {
      // A source we failed to delete is wasted disk, not a failed burn —
      // the captioned output is already on disk and the reel is already
      // in the Subtitled column. Log it and move on rather than throwing
      // the operator into a "failed" state for a finished video.
      console.warn(
        `[burn] reel ${reelId}: could not delete source video — ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setCaptions(reelId, "failed", null, message);
    throw err;
  } finally {
    // Intermediate files aren't needed once burned; the extracted audio and
    // ASS subtitle file would otherwise pile up in the reel folder. This
    // block runs on both success and failure and never touches sourcePath —
    // on failure it must survive for a retry, and on success its own
    // deletion already happened above (conditionally, only once burning
    // actually succeeded).
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
        hashtag_id: null,
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
        source_caption: scraped?.caption ?? null,
        source_hashtags: scraped?.hashtags ?? null,
        publish_pack: null,
        publish_pack_status: "none",
        publish_pack_error: null,
        source_video_path: null,
        slug: null,
        status: "new",
        previous_status: null,
        thumbnail_url: scraped?.thumbnailUrl ?? null,
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
    thumbnail_url: scraped?.thumbnailUrl ?? null,
    source_caption: scraped?.caption ?? null,
    source_hashtags: scraped?.hashtags ?? null,
  });

  return {
    reel,
    qualifies,
    forced: !qualifies && force,
    alreadyExisted: false,
  };
}

// --- Scan (weekly cron + "Run scan now", both discovery modes) ---
export interface ScanSummary {
  scannedAccounts: number;
  scannedHashtags: number;
  newReels: number;
  errors: number;
}

async function logScan(
  accountId: number | null,
  handle: string,
  status: string,
  message: string,
  reelsFound: number
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO scan_logs (account_id, handle, status, message, reels_found)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, handle, status, message, reelsFound]
  );
}

// Tracked-account scan: cheap per-account sweep, qualify on views, pull a
// transcript only for genuinely new reels. Unchanged from the original
// single-mode runScan other than being split into its own function.
async function scanTrackedAccounts(): Promise<{ count: number; newReels: number; errors: number }> {
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
          thumbnail_url: r.thumbnailUrl,
          source_caption: r.caption,
          source_hashtags: r.hashtags,
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

  return { count: accounts.length, newReels, errors };
}

// Hashtag discovery scan (2026-08-24). Three-stage funnel per hashtag, cheap
// to expensive, mirroring the account scan's cheap-sweep-then-transcript
// pattern:
//   1. Cheap hashtag sweep (scanHashtag) — view counts + thumbnails only.
//   2. View-count qualification (same VIEW_THRESHOLD as account scans),
//      skipping anything already on record (by shortcode) before spending
//      a Gemini call on it.
//   3. Talking-head format classification on the thumbnail (Gemini vision) —
//      only reels that read as "person on camera, upscale background" move
//      on. Reels that don't qualify visually are neither inserted nor
//      transcript-pulled, since the whole point is filtering OUT skits/other
//      formats before the expensive per-reel transcript call.
// A classification failure (bad thumbnail fetch, model error) skips just
// that candidate — same "fail loud but don't abort the batch" pattern as the
// account scan's per-account try/catch, since one broken thumbnail shouldn't
// sink the rest of the hashtag's results.
async function scanTrackedHashtags(): Promise<{ count: number; newReels: number; errors: number }> {
  const hashtags = (await listHashtags()).filter((h) => h.active === 1);

  let newReels = 0;
  let errors = 0;

  for (const hashtag of hashtags) {
    try {
      const scraped = await scanHashtag(hashtag.tag);
      const qualifying = scraped.filter(
        (r) => r.views !== null && r.views >= config.viewThreshold && r.url
      );

      let foundForHashtag = 0;
      let skippedFormat = 0;
      for (const r of qualifying) {
        const shortcode = r.shortcode ?? extractShortcode(r.url);
        if (shortcode && (await findByShortcode(shortcode))) continue; // already on record

        if (!r.thumbnailUrl) {
          skippedFormat += 1;
          continue; // can't classify format without a thumbnail
        }
        try {
          const classification = await classifyTalkingHead(r.thumbnailUrl);
          if (!classification.isTalkingHead) {
            skippedFormat += 1;
            continue;
          }
        } catch {
          skippedFormat += 1;
          continue;
        }

        const reel = await insertReel({
          hashtag_id: hashtag.id,
          url: r.url,
          shortcode: r.shortcode,
          views: r.views,
          source: "hashtag_scan",
          thumbnail_url: r.thumbnailUrl,
          source_caption: r.caption,
          source_hashtags: r.hashtags,
        });
        if (reel.transcript_status === "pending" && !reel.transcript) {
          foundForHashtag += 1;
          await retrieveTranscript(reel.id);
        }
      }

      await markHashtagScanned(hashtag.id, foundForHashtag);
      newReels += foundForHashtag;
      await logScan(
        null,
        `#${hashtag.tag}`,
        "ok",
        `${qualifying.length} qualifying, ${skippedFormat} not talking-head, ${foundForHashtag} new`,
        foundForHashtag
      );
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await logScan(null, `#${hashtag.tag}`, "error", message, 0);
    }
  }

  return { count: hashtags.length, newReels, errors };
}

export async function runScan(): Promise<ScanSummary> {
  const accountResult = await scanTrackedAccounts();
  const hashtagResult = await scanTrackedHashtags();
  return {
    scannedAccounts: accountResult.count,
    scannedHashtags: hashtagResult.count,
    newReels: accountResult.newReels + hashtagResult.newReels,
    errors: accountResult.errors + hashtagResult.errors,
  };
}
