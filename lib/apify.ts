import { ApifyClient } from "apify-client";
import { config, hasApify } from "./config";

// Instagram Reel Scraper (apify/instagram-reel-scraper).
//
// VERIFIED LIVE 2026-07-18 against the actor's published input schema:
//   - `username` is the ONLY required field, and it accepts a username,
//     profile URL, ID, **or a reel URL**. There is no `directUrls` field —
//     single-reel fetch goes through `username` too.
//   - Other inputs: resultsLimit, onlyPostsNewerThan, skipPinnedPosts,
//     skipTrialReels, includeSharesCount, includeTranscript,
//     includeDownloadedVideo. There is NO proxy setting — the actor manages
//     proxies internally.
//   - Transcript comes back on the `transcript` field (confirmed live).
//   - Views: `videoViewCount` and `videoPlayCount` differ substantially
//     (e.g. 367,365 vs 754,069 on the same reel). Instagram's public "views"
//     number on a reel maps to PLAYS, so playCount is the default metric.
//
// ⚠️ Failure mode that matters: a blocked or private profile still returns a
// run with status SUCCEEDED — the failure arrives as a dataset ITEM carrying
// an `error` field (e.g. "no_items"). We must detect that and throw, or the
// scan silently reports "0 qualifying reels" when it actually failed.

export interface ScrapedReel {
  url: string;
  shortcode: string | null;
  views: number | null;
  caption: string | null;
  transcript: string | null;
  ownerUsername: string | null;
}

interface ActorItem {
  error?: string;
  errorDescription?: string;
  [key: string]: unknown;
}

function client(): ApifyClient {
  if (!hasApify()) {
    throw new Error(
      "APIFY_TOKEN is not set. Add it to .env.local to use the scraper."
    );
  }
  // maxRetries is a HARD CAP (project rule: never loop silently against paid API).
  return new ApifyClient({
    token: config.apifyToken,
    maxRetries: config.apifyMaxRetries,
  });
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseInt(v, 10) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function mapItem(item: ActorItem): ScrapedReel {
  const plays = num(item.videoPlayCount);
  const views = num(item.videoViewCount);
  return {
    url: (item.url as string) ?? (item.inputUrl as string) ?? "",
    shortcode: (item.shortCode as string) ?? null,
    // Instagram's displayed "views" == plays. Configurable via VIEW_METRIC.
    views:
      config.viewMetric === "viewCount" ? (views ?? plays) : (plays ?? views),
    caption: (item.caption as string) ?? null,
    transcript: (item.transcript as string) ?? null,
    ownerUsername: (item.ownerUsername as string) ?? null,
  };
}

// Runs the actor and returns mapped items. Throws on actor-reported errors
// (blocked / private / empty) even though the run itself "SUCCEEDED".
async function runActor(
  input: Record<string, unknown>
): Promise<ScrapedReel[]> {
  const c = client();
  const run = await c.actor(config.apifyActor).call(input);
  const { items } = await c.dataset(run.defaultDatasetId).listItems();
  const rows = items as ActorItem[];

  const failed = rows.find((i) => i.error);
  if (failed) {
    throw new Error(
      `Apify: ${failed.error}${
        failed.errorDescription ? ` — ${failed.errorDescription}` : ""
      }`
    );
  }
  return rows.filter((i) => i.shortCode).map(mapItem);
}

// Weekly scan: view counts only (transcript OFF — the cheap sweep).
// `since` (ISO date) narrows the sweep to posts newer than the last scan.
export async function scanAccount(
  handle: string,
  since?: string | null
): Promise<ScrapedReel[]> {
  const input: Record<string, unknown> = {
    username: [handle],
    resultsLimit: config.scanPostsPerAccount,
    includeTranscript: false,
    includeDownloadedVideo: false,
    includeSharesCount: false,
    skipPinnedPosts: true,
    skipTrialReels: true,
  };
  if (since) input.onlyPostsNewerThan = since.slice(0, 10);
  return runActor(input);
}

// Single reel by URL, with transcript ON (per-minute charge — qualifiers only).
// Note: the reel URL goes in `username`; the actor accepts URLs there.
export async function fetchReel(url: string): Promise<ScrapedReel | null> {
  const rows = await runActor({
    username: [url],
    resultsLimit: 1,
    includeTranscript: true,
    includeDownloadedVideo: false,
    includeSharesCount: false,
  });
  return rows[0] ?? null;
}
