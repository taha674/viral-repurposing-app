import { getPool } from "./db";
import type { Brand, SourceKind, TrackedHashtag } from "./types";

// Mirrors lib/accounts.ts exactly — same lifecycle (active/pause, last scan,
// running found-count), just for the hashtag-based discovery mode
// (2026-08-24) instead of tracked accounts.

interface HashtagRow extends Omit<TrackedHashtag, "active"> {
  active: boolean;
}

function mapHashtag(row: HashtagRow): TrackedHashtag {
  return { ...row, active: row.active ? 1 : 0 };
}

export async function listHashtags(brand?: Brand): Promise<TrackedHashtag[]> {
  const pool = await getPool();
  const { rows } = await pool.query<HashtagRow>(
    `SELECT * FROM tracked_hashtags WHERE ($1::text IS NULL OR brand = $1) ORDER BY active DESC, tag ASC`,
    [brand ?? null]
  );
  return rows.map(mapHashtag);
}

export async function getHashtag(id: number): Promise<TrackedHashtag | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<HashtagRow>(
    "SELECT * FROM tracked_hashtags WHERE id = $1",
    [id]
  );
  return rows[0] ? mapHashtag(rows[0]) : undefined;
}

// Normalize a hashtag: strip leading '#', whitespace, lowercase. A keyword
// gets the same treatment but keeps (collapsed) inner spaces: "hifz revision".
// Deliberately
// does NOT "correct" spelling (e.g. "millionnaire" stays as typed) — this is
// exactly the string passed to the scraper actor and must match what Taha
// intends to search.
export function normalizeHashtag(input: string, kind: SourceKind = "hashtag"): string {
  const t = input.trim().toLowerCase().replace(/^#/, "").trim();
  return kind === "keyword" ? t.replace(/\s+/g, " ") : t;
}

export async function addHashtag(
  rawTag: string,
  brand: Brand,
  kind: SourceKind = "hashtag"
): Promise<TrackedHashtag> {
  const tag = normalizeHashtag(rawTag, kind);
  if (!tag) throw new Error(`Empty ${kind}`);
  const pool = await getPool();
  await pool.query(
    "INSERT INTO tracked_hashtags (tag, brand, kind) VALUES ($1, $2, $3) ON CONFLICT (tag) DO NOTHING",
    [tag, brand, kind]
  );
  const { rows } = await pool.query<HashtagRow>(
    "SELECT * FROM tracked_hashtags WHERE tag = $1",
    [tag]
  );
  // tag is unique across brands, so a source tracked by the other brand
  // comes back here instead of being inserted — say so rather than silently
  // handing back the other brand's row.
  if (rows[0].brand !== brand) {
    throw new Error(`Already tracked under ${rows[0].brand}`);
  }
  if (rows[0].kind !== kind) {
    throw new Error(`"${tag}" is already tracked as a ${rows[0].kind}`);
  }
  return mapHashtag(rows[0]);
}

export async function setHashtagActive(id: number, active: boolean): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE tracked_hashtags SET active = $1 WHERE id = $2", [
    active,
    id,
  ]);
}

export async function removeHashtag(id: number): Promise<void> {
  const pool = await getPool();
  await pool.query("DELETE FROM tracked_hashtags WHERE id = $1", [id]);
}

export async function markHashtagScanned(id: number, foundDelta: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE tracked_hashtags
       SET last_scanned_at = now(),
           reels_found_count = reels_found_count + $1
     WHERE id = $2`,
    [foundDelta, id]
  );
}
