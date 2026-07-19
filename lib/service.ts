import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { config } from "./config";
import { getDb } from "./db";
import { listAccounts, markScanned } from "./accounts";
import {
  insertReel,
  getReel,
  setTranscript,
  setAdaptation,
  setVoiceover,
  extractShortcode,
} from "./reels";
import { scanAccount, fetchReel } from "./apify";
import { runAdaptation } from "./gemini";
import { generateVoiceover as callElevenLabs } from "./elevenlabs";
import type { Reel, RedLineFlag } from "./types";

// --- Transcript retrieval (shared by manual add + scan) ---
// The Apify client already hard-caps retries; here we just translate a failed
// pull into a flagged status rather than looping. Fail loud, never silently.
export async function retrieveTranscript(reelId: number): Promise<Reel> {
  const reel = getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  try {
    const scraped = await fetchReel(reel.url);
    if (scraped?.transcript) {
      setTranscript(reelId, scraped.transcript, "success");
    } else {
      setTranscript(reelId, reel.transcript, "failed");
    }
  } catch {
    setTranscript(reelId, reel.transcript, "failed");
  }
  return getReel(reelId)!;
}

// --- Red-line-compliance adaptation (manually triggered) ---
export async function adaptReel(reelId: number): Promise<Reel> {
  const reel = getReel(reelId);
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

  setAdaptation(
    reelId,
    result.analysis,
    result.adapted_script,
    finalFlag,
    finalReason
  );
  return getReel(reelId)!;
}

// --- ElevenLabs voiceover generation (manually triggered, approved scripts only) ---
// Budget guard runs before any network call — never spend credits on an
// oversized script. Failures are persisted and rethrown: fail loud, never
// loop silently against a paid API (ELEVENLABS_MAX_RETRIES is the hard cap,
// enforced inside elevenlabs.ts).
export async function generateVoiceover(reelId: number): Promise<Reel> {
  const reel = getReel(reelId);
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
    setVoiceover(reelId, "failed", null, message);
    throw new Error(message);
  }

  try {
    const audio = await callElevenLabs(script);
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(config.reelsOutputDir, `${reelId}_${today}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "voiceover.mp3");
    fs.writeFileSync(filePath, audio);
    setVoiceover(reelId, "success", filePath, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setVoiceover(reelId, "failed", null, message);
    throw err;
  }

  return getReel(reelId)!;
}

// --- Reveal the generated voiceover in Finder (local machine only) ---
export async function revealVoiceover(reelId: number): Promise<void> {
  const reel = getReel(reelId);
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
  const reel = insertReel({
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
  const db = getDb();
  const accounts = listAccounts().filter((a) => a.active === 1);
  const logInsert = db.prepare(
    `INSERT INTO scan_logs (account_id, handle, status, message, reels_found)
     VALUES (?, ?, ?, ?, ?)`
  );

  let newReels = 0;
  let errors = 0;

  for (const account of accounts) {
    try {
      // Narrow the sweep to posts newer than the last successful scan.
      const scraped = await scanAccount(account.handle, account.last_scanned_at);
      const qualifying = scraped.filter(
        (r) => r.views !== null && r.views >= config.viewThreshold && r.url
      );

      let foundForAccount = 0;
      for (const r of qualifying) {
        const reel = insertReel({
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

      markScanned(account.id, foundForAccount);
      newReels += foundForAccount;
      logInsert.run(
        account.id,
        account.handle,
        "ok",
        `${qualifying.length} qualifying, ${foundForAccount} new`,
        foundForAccount
      );
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      logInsert.run(account.id, account.handle, "error", message, 0);
    }
  }

  return { scannedAccounts: accounts.length, newReels, errors };
}
