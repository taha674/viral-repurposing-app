import { randomUUID } from "node:crypto";
import { config, hasTreg } from "./config";
import { getPool } from "./db";

// Every Instagram read goes through treg (https://treg.to), which replaced
// Apify on 2026-10-18 (ticket 15: Apify's credit ran out). treg injects the
// provider keys server-side and bills the team balance per call.
//
// The four list/detail reads use treg's ROUTED tools (treg.instagram.*):
// treg picks a provider and, on a provider error or a miss, moves to the
// next one inside the same call, capped by X-Treg-Route-Max-Cost. That is
// the "try another provider on 429/5xx/timeout" rule, done by treg; the
// provider that answered is in `_treg.served_by` and logged. The transcript
// endpoint has no sibling provider, so a failure there marks the transcript
// failed and the operator pastes one by hand, as before.
//
// Routed rows are PROVIDER-NATIVE: the same reel comes back as anyapi's
// {shortcode, views, thumbnail}, crawl4ai's {code, plays}, scrapecreators'
// {shortcode, video_play_count, display_url}, tikhub's raw Instagram media
// {code, play_count, caption.text, image_versions2} and so on. mapRow()
// reads each known variant into the one ScrapedReel shape (field names taken
// from each child endpoint's catalog example, 2026-10-18).

export interface ScrapedReel {
  url: string;
  shortcode: string | null;
  views: number | null;
  comments: number | null;
  caption: string | null;
  // Hashtags carried on the source post, parsed out of `caption`.
  hashtags: string[];
  ownerUsername: string | null;
  // Cover image. Instagram's CDN URLs are signed and expire, so the UI treats
  // a broken thumbnail as "no thumbnail" rather than an error.
  thumbnailUrl: string | null;
}

type Row = Record<string, unknown>;

// --- the one call ----------------------------------------------------------

async function spentTodayMicro(): Promise<number> {
  const pool = await getPool();
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COALESCE(SUM(cost_micro), 0)::text AS n FROM provider_spend WHERE at >= date_trunc('day', now())"
  );
  return Number(rows[0]?.n ?? 0);
}

async function recordSpend(endpoint: string, res: Response): Promise<void> {
  const cost = Number(res.headers.get("x-treg-cost-micro") ?? 0);
  if (!(cost > 0)) return;
  const pool = await getPool();
  await pool.query(
    "INSERT INTO provider_spend (provider, endpoint, served_by, call_id, cost_micro) VALUES ('treg', $1, $2, $3, $4)",
    [endpoint, res.headers.get("x-treg-served-by"), res.headers.get("x-treg-call-id"), cost]
  );
}

// One treg call. Hard caps (project rule: never loop against a paid API):
// TREG_DAILY_SPEND_CAP_USD refuses the call once today's recorded spend
// reaches it; 429 / 5xx / timeout are retried at most TREG_MAX_RETRIES times
// with the SAME Idempotency-Key, so an answer lost on the way back is
// replayed for free instead of billed twice; a 4xx is never retried (it is
// our parameters, and retrying burns money).
export async function tregCall(
  endpoint: string,
  init: {
    body?: Row;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    // Override TREG_MAX_RETRIES; 0 for a call that must never repeat
    // (publishing a post).
    retries?: number;
  }
): Promise<Row> {
  if (!hasTreg()) {
    throw new Error("TREG_TOKEN is not set. Add the app's capped treg agent token to .env.local.");
  }
  const spent = await spentTodayMicro();
  if (spent >= config.tregDailySpendCapUsd * 1e6) {
    throw new Error(
      `treg daily spend cap reached ($${(spent / 1e6).toFixed(4)} of $${config.tregDailySpendCapUsd}). Raise TREG_DAILY_SPEND_CAP_USD or wait until tomorrow.`
    );
  }

  const url = new URL(`${config.tregBaseUrl.replace(/\/$/, "")}/call/${endpoint}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    "X-Treg-Token": config.tregToken,
    "Idempotency-Key": randomUUID(),
    "X-Treg-Route-Max-Cost": String(config.tregRouteMaxCostUsd),
    ...init.headers,
  };
  if (init.body) headers["content-type"] = "application/json";

  const attempts = Math.max(1, (init.retries ?? config.tregMaxRetries) + 1);
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.body ? "POST" : "GET",
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(config.tregTimeoutMs),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue; // timeout / network: retryable
    }
    await recordSpend(endpoint, res);
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as Row;
      } catch {
        throw new Error(`treg ${endpoint}: response was not JSON: ${text.slice(0, 200)}`);
      }
    }
    lastError = `${res.status} ${text.slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) break; // 4xx: never retry
  }
  throw new Error(`treg ${endpoint} failed (up to ${attempts} attempt(s)): ${lastError}`);
}

// Routed calls answer {output, raw, _treg: {served_by, tried}}.
async function routed(
  endpoint: string,
  body: Row,
  headers?: Record<string, string>
): Promise<{ output: Row; raw: Row; servedBy: string }> {
  const res = await tregCall(endpoint, { body, headers });
  const meta = (res._treg ?? {}) as Row;
  const servedBy = String(meta.served_by ?? "unknown");
  const tried = Array.isArray(meta.tried) ? meta.tried.length : 0;
  if (tried > 1) console.log(`[treg] ${endpoint}: served by ${servedBy} after trying ${tried} providers`);
  return { output: (res.output ?? {}) as Row, raw: (res.raw ?? {}) as Row, servedBy };
}

// --- mapping provider-native rows ------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
function firstNum(...vs: unknown[]): number | null {
  for (const v of vs) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}
const obj = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);
const first = (v: unknown): Row | null => (Array.isArray(v) ? obj(v[0]) : null);

// Some providers wrap the media object: tikhub {media: {...}}, GraphQL
// {node: {...}}, scrapecreators {data: {xdt_shortcode_media: {...}}}.
function unwrap(r: Row): Row {
  const media = obj(r.media);
  if (media && (media.code || media.shortcode)) return media;
  const node = obj(r.node);
  if (node) return node;
  const xdt = obj(obj(r.data)?.xdt_shortcode_media);
  if (xdt) return xdt;
  return r;
}

const SHORTCODE_IN_URL = /instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/;

export function mapRow(raw: Row): ScrapedReel | null {
  const r = unwrap(raw);
  const urlIn = str(r.url) ?? str(r.permalink);
  const shortcode =
    str(r.shortcode) ?? str(r.code) ?? str(r.shortCode) ?? str(r.content_id) ??
    (urlIn ? urlIn.match(SHORTCODE_IN_URL)?.[1] ?? null : null);
  if (!shortcode) return null;
  const graphqlCaption = obj(first(obj(r.edge_media_to_caption)?.edges)?.node)?.text;
  const caption =
    str(r.caption) ?? str(obj(r.caption)?.text) ?? str(r.description) ?? str(graphqlCaption);
  return {
    url: urlIn ?? `https://www.instagram.com/reel/${shortcode}/`,
    shortcode,
    // Instagram's public "views" on a reel is plays, so plays come first;
    // video_view_count runs far lower on the same reel.
    views: firstNum(
      r.play_count, r.plays, r.video_play_count, r.ig_play_count, r.playCount, r.videoPlayCount,
      r.views, r.view_count, r.video_view_count, r.videoViewCount
    ),
    comments: firstNum(r.comments, r.comment_count, r.comments_count, r.num_comments, obj(r.edge_media_to_comment)?.count),
    caption,
    hashtags: parseHashtags(caption),
    ownerUsername:
      str(r.username) ?? str(obj(r.owner)?.username) ?? str(r.owner) ?? str(obj(r.user)?.username) ??
      str(r.user_posted) ?? str(r.author),
    thumbnailUrl:
      str(r.thumbnail) ?? str(r.displayUrl) ?? str(r.display_url) ?? str(r.thumbnail_src) ??
      str(r.thumbnail_url) ?? str(first(obj(r.image_versions2)?.candidates)?.url) ??
      str(first(r.media)?.url) ?? (Array.isArray(r.photos) ? str(r.photos[0]) : null),
  };
}

// --- carousels ----------------------------------------------------------------

export interface ScrapedCarousel {
  url: string;
  shortcode: string;
  likes: number | null;
  caption: string | null;
  hashtags: string[];
  ownerUsername: string | null;
  thumbnailUrl: string | null;
  // The still slides in order (a video slide is dropped).
  slideUrls: string[];
}

// tikhub gives a post's pictures as a list of renditions or as {items: [...]}.
function firstImageUrl(v: unknown): string | null {
  return str(first(Array.isArray(v) ? v : obj(v)?.items)?.url);
}

// A carousel as tikhub's feeds shape it: slides under `carousel_media` (an
// account's posts) or `resources` (a hashtag feed), caption as text or {text}.
// Null for anything that is not a carousel or has no still slide.
export function mapCarousel(raw: Row): ScrapedCarousel | null {
  if (raw.media_type !== 8 && raw.product_type !== "carousel_container") return null;
  const shortcode = str(raw.code) ?? str(raw.shortcode);
  if (!shortcode) return null;
  const slides = rowsOf(raw.carousel_media).length ? rowsOf(raw.carousel_media) : rowsOf(raw.resources);
  const slideUrls = slides
    // Still slides carry `video_versions: []`; only a non-empty list is a video.
    .filter((s) => s.media_type !== 2 && !rowsOf(s.video_versions).length)
    .map((s) => firstImageUrl(s.image_versions))
    .filter((u): u is string => !!u);
  if (!slideUrls.length) return null;
  const caption = str(raw.caption_text) ?? str(obj(raw.caption)?.text) ?? str(raw.caption);
  return {
    url: `https://www.instagram.com/p/${shortcode}/`,
    shortcode,
    likes: firstNum(raw.like_count),
    caption,
    hashtags: parseHashtags(caption),
    ownerUsername: str(obj(raw.user)?.username) ?? str(obj(raw.owner)?.username),
    thumbnailUrl: str(raw.thumbnail_url) ?? slideUrls[0],
    slideUrls,
  };
}

const carouselsIn = (res: Row): ScrapedCarousel[] =>
  rowsOf(obj(obj(res.data)?.data)?.items).map(mapCarousel).filter((c): c is ScrapedCarousel => c !== null);

// Hashtag feeds mix photos, carousels and reels; keep the reels.
function isReel(raw: Row): boolean {
  const r = unwrap(raw);
  const url = str(r.url) ?? "";
  if (/\/(reel|reels|tv)\//.test(url)) return true;
  if (r.product_type === "clips" || r.is_video === true || r.media_type === 2) return true;
  return /video|clips|reel/i.test(String(r.__typename ?? r.type ?? r.content_type ?? r.media_type ?? ""));
}

const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!obj(x)) : []);
const mapAll = (rows: Row[]): ScrapedReel[] => rows.map(mapRow).filter((r): r is ScrapedReel => r !== null);

// --- the reads --------------------------------------------------------------

// An account's reels (metadata only). One routed call returns one page,
// typically ~12 reels.
// ponytail: one page per account per scan; paginate when the ranked history needs to go deeper.
export async function scanAccount(handle: string, limit: number): Promise<ScrapedReel[]> {
  const { output } = await routed("treg.instagram.user.reels", { username: handle.replace(/^@/, ""), limit });
  return mapAll(rowsOf(output.reels));
}

// Reels under a hashtag. Some providers carry no view counts here; the scan
// fills them from fetchReel() for the candidates that pass the format filter.
export async function scanHashtag(tag: string): Promise<ScrapedReel[]> {
  const { output } = await routed("treg.instagram.hashtag.posts", { hashtag: tag });
  return mapAll(rowsOf(output.posts).filter(isReel));
}

// Carousels under a hashtag. The routed hashtag call above comes back
// reels-only, so this reads tikhub's feed directly, where carousels ride along
// with the reels (~$0.002 a page).
export async function scanHashtagCarousels(tag: string): Promise<ScrapedCarousel[]> {
  return carouselsIn(await tregCall("tikhub.x.instagram-v2-fetch-hashtag-posts", { query: { keyword: tag } }));
}

// An account's carousels. The routed user-posts call can be served by a
// provider that returns bare post codes, so this reads tikhub's by username.
export async function scanAccountCarousels(handle: string): Promise<ScrapedCarousel[]> {
  return carouselsIn(
    await tregCall("tikhub.x.instagram-v2-fetch-user-posts", { query: { username: handle.replace(/^@/, "") } })
  );
}

// Reels matching a keyword (a "keyword" discovery source). Instagram's reel
// search carries no view counts on most providers, same follow-up as above.
export async function searchReels(query: string): Promise<ScrapedReel[]> {
  const { output } = await routed("treg.instagram.search.reels", { q: query });
  return mapAll(rowsOf(output.reels));
}

// One reel by URL: views, caption, thumbnail. No transcript (fetchTranscript).
// anyapi is excluded: it is the cheapest child but its default source carries
// no play count, and the view count is the point of most of these lookups.
export async function fetchReel(url: string): Promise<ScrapedReel | null> {
  const { output, raw } = await routed("treg.instagram.post.detail", { url }, { "X-Treg-Route-Exclude": "anyapi" });
  const row = obj(output.post) ?? obj(output.data) ?? output;
  const reel = mapRow(row);
  // The routed `output` can omit the play count that the provider's own
  // `raw` body carries (tikhub: raw.data.video_play_count), and a reel
  // without views never meets a view floor.
  if (reel && reel.views === null) reel.views = mapRow(obj(raw.data) ?? raw)?.views ?? null;
  return reel;
}

// The reel's speech as text (ScrapeCreators speech-to-text). Null when the
// reel has no speech or the provider returned none.
export async function fetchTranscript(url: string): Promise<string | null> {
  const res = await tregCall("scrapecreators.x.v2-instagram-media-transcript", { query: { url } });
  const parts = rowsOf(res.transcripts).map((t) => str(t.text)).filter((t): t is string => !!t);
  return parts.length ? parts.join("\n\n") : null;
}

// --- caption helpers ---------------------------------------------------------

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
