import { config } from "./config";
import { deleteSetting, getSetting, setSetting } from "./settings";

// Operator-editable scan controls, stored in the settings table. Env vars in
// config.ts stay the fallback for the limits, so nothing changes until the
// operator saves an override.
//
// Scheduled scanning is OFF unless explicitly enabled (absent key = off). The
// scheduled run cost real Apify spend unattended, so a fresh deploy or a
// wiped settings row must never silently turn it back on. Manual "Run scan
// now" and the MCP run_scan tool are unaffected by the switch.

const ENABLED_KEY = "scan.scheduled_enabled";

export type ScanLimits = {
  // Total NEW reels one scan run admits (each costs a paid transcript pull).
  minNewReelsPerRun: number;
  // New reels taken per account per round-robin turn.
  batchPerAccount: number;
  // Posts pulled per tracked account (metadata only).
  postsPerAccount: number;
  // Reels pulled per hashtag.
  postsPerHashtag: number;
};

export const SCAN_LIMIT_DEFAULTS: ScanLimits = {
  minNewReelsPerRun: 10,
  batchPerAccount: config.scanBatchPerAccount,
  postsPerAccount: config.scanPostsPerAccount,
  postsPerHashtag: config.scanPostsPerHashtag,
};

// Hard ceilings so a typo in the UI can't become a runaway paid pull.
export const SCAN_LIMIT_MAX: ScanLimits = {
  minNewReelsPerRun: 50,
  batchPerAccount: 10,
  postsPerAccount: 500,
  postsPerHashtag: 100,
};

const LIMIT_KEYS: Record<keyof ScanLimits, string> = {
  minNewReelsPerRun: "scan.min_new_reels_per_run",
  batchPerAccount: "scan.batch_per_account",
  postsPerAccount: "scan.posts_per_account",
  postsPerHashtag: "scan.posts_per_hashtag",
};

export async function isScheduledScanEnabled(): Promise<boolean> {
  return (await getSetting(ENABLED_KEY)) === "true";
}

export async function setScheduledScanEnabled(enabled: boolean): Promise<void> {
  await setSetting(ENABLED_KEY, enabled ? "true" : "false");
}

export async function getScanLimits(): Promise<ScanLimits> {
  const out = { ...SCAN_LIMIT_DEFAULTS };
  for (const k of Object.keys(LIMIT_KEYS) as (keyof ScanLimits)[]) {
    const n = parseInt((await getSetting(LIMIT_KEYS[k])) ?? "", 10);
    if (Number.isInteger(n) && n >= 1 && n <= SCAN_LIMIT_MAX[k]) out[k] = n;
  }
  return out;
}

// Returns an error string for the first invalid field, else null after saving.
export async function saveScanLimits(input: unknown): Promise<string | null> {
  if (!input || typeof input !== "object") return "Invalid body";
  const body = input as Record<string, unknown>;
  const parsed: Partial<ScanLimits> = {};
  for (const k of Object.keys(LIMIT_KEYS) as (keyof ScanLimits)[]) {
    const n = body[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > SCAN_LIMIT_MAX[k]) {
      return `${k} must be a whole number between 1 and ${SCAN_LIMIT_MAX[k]}`;
    }
    parsed[k] = n;
  }
  for (const k of Object.keys(LIMIT_KEYS) as (keyof ScanLimits)[]) {
    await setSetting(LIMIT_KEYS[k], String(parsed[k]));
  }
  return null;
}

export async function resetScanLimits(): Promise<void> {
  for (const key of Object.values(LIMIT_KEYS)) await deleteSetting(key);
}
