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
  // Hashtags carried on the source post, parsed out of `caption` (and unioned
  // with the actor's own `hashtags` array when it emits one). Comes free with
  // the scrape we already pay for — see parseHashtags below.
  hashtags: string[];
  transcript: string | null;
  ownerUsername: string | null;
  // Cover/preview image, if the actor returned one. Field name isn't
  // pinned down against the live schema the way the others are (see the
  // module-level VERIFIED note) — `displayUrl` is the common field across
  // Apify's Instagram actors, with a couple of fallbacks. Best-effort only:
  // Instagram's CDN URLs are signed and expire, so the UI treats a broken
  // thumbnail as "no thumbnail" rather than an error.
  thumbnailUrl: string | null;
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

function thumbnailOf(item: ActorItem): string | null {
  const images = item.images as unknown;
  const fromImages =
    Array.isArray(images) && typeof images[0] === "string" ? images[0] : null;
  return (
    (item.displayUrl as string) ??
    (item.thumbnailUrl as string) ??
    (item.coverUrl as string) ??
    fromImages ??
    null
  );
}

// Hashtags on the source post. Instagram tags allow unicode letters, digits
// and underscore (no hyphens, no periods), so the class is deliberately
// narrower than \w plus \p{L}/\p{N} — `#wealth.tips` is the tag "#wealth",
// not "#wealth.tips". Returned WITHOUT the leading '#', de-duped
// case-insensitively (Instagram treats #Wealth and #wealth as one tag) while
// preserving the casing of the first occurrence for display.
export function parseHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = m[1];
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// The caption with its hashtags removed — the prose half, for feeding to a
// model that gets the tag list separately. Collapses the whitespace the
// removal leaves behind (tag blocks are usually a trailing run of lines).
export function captionBody(caption: string | null | undefined): string | null {
  if (!caption) return null;
  const body = caption
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  return body || null;
}

// Union of the tags parsed from the caption and any the actor supplies
// directly. Neither actor is documented to emit a `hashtags` field, but if
// one starts to, taking it costs nothing and is more reliable than parsing.
function hashtagsOf(item: ActorItem): string[] {
  const caption = (item.caption as string) ?? null;
  const fromCaption = parseHashtags(caption);
  const raw = item.hashtags;
  if (!Array.isArray(raw)) return fromCaption;
  const seen = new Set(fromCaption.map((t) => t.toLowerCase()));
  const out = [...fromCaption];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.replace(/^#/, "").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
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
    hashtags: hashtagsOf(item),
    transcript: (item.transcript as string) ?? null,
    ownerUsername: (item.ownerUsername as string) ?? null,
    thumbnailUrl: thumbnailOf(item),
  };
}

// Runs the given actor and returns mapped items. Throws on actor-reported
// errors (blocked / private / empty) even though the run itself "SUCCEEDED".
async function runActor(
  actorId: string,
  input: Record<string, unknown>
): Promise<ScrapedReel[]> {
  const c = client();
  const run = await c.actor(actorId).call(input);
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
//
// Deliberately does NOT pass onlyPostsNewerThan. "New reel" detection
// already happens entirely at our own DB layer (insertReel dedupes on
// shortcode; runScan only pulls a transcript for genuinely-new rows) — the
// Apify-side date cursor was a pure optimization, not load-bearing for
// correctness. It was removed 2026-08-22 after it caused false failures: the
// actor reports "no posts match this filter" with the same generic
// `error: "no_items"` / "Empty or private data for provided input" it uses
// for an actually-blocked or private profile, so there's no way to tell
// "nothing new since last scan" (healthy) apart from "genuinely can't scrape
// this account" (a real failure) from the response alone. Always fetching
// the last `resultsLimit` posts and letting our dedupe sort out what's new
// avoids that ambiguity entirely, and costs nothing extra — the original
// volume estimate in reference-inputs.md already assumed the full per-account
// pull, not a filtered subset.
export async function scanAccount(handle: string): Promise<ScrapedReel[]> {
  const input: Record<string, unknown> = {
    username: [handle],
    resultsLimit: config.scanPostsPerAccount,
    includeTranscript: false,
    includeDownloadedVideo: false,
    includeSharesCount: false,
    skipPinnedPosts: true,
    skipTrialReels: true,
  };
  return runActor(config.apifyActor, input);
}

// Single reel by URL, with transcript ON (per-minute charge — qualifiers only).
// Note: the reel URL goes in `username`; the actor accepts URLs there.
export async function fetchReel(url: string): Promise<ScrapedReel | null> {
  const rows = await runActor(config.apifyActor, {
    username: [url],
    resultsLimit: 1,
    includeTranscript: true,
    includeDownloadedVideo: false,
    includeSharesCount: false,
  });
  return rows[0] ?? null;
}

// Hashtag discovery scan (2026-08-24, apify/instagram-hashtag-scraper).
//
// NOT live-verified the way apifyActor above is — this is built against
// Apify's published input/output schema docs, not a confirmed real run.
// Schema: input `{ hashtags: string[], resultsType: "reels" | "posts",
// resultsLimit }`; output fields for resultsType "reels" documented as
// shortCode, url, type, caption, timestamp, likesCount, commentsCount,
// sharesCount, videoPlayCount, videoViewCount, ownerUsername, ownerFullName,
// ownerId, displayUrl, videoUrl, videoDuration — the view/thumbnail/owner
// field names line up with the reel-scraper's ActorItem shape above, so
// mapItem() is reused as-is. `resultsType: "reels"` means every row
// returned is already video content — no separate photo/carousel filter
// needed on our end.
//
// Cheap sweep only (mirrors scanAccount): no transcript field exists on this
// actor's output at all — a qualifying, format-matching candidate still goes
// through fetchReel() afterwards for the transcript, exactly like an
// account-scan qualifier does.
export async function scanHashtag(tag: string): Promise<ScrapedReel[]> {
  const input: Record<string, unknown> = {
    hashtags: [tag],
    resultsType: "reels",
    resultsLimit: config.scanPostsPerHashtag,
  };
  return runActor(config.apifyHashtagActor, input);
}
