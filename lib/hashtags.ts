import { getPool } from "./db";
import type { TrackedHashtag } from "./types";

// Mirrors lib/accounts.ts exactly — same lifecycle (active/pause, last scan,
// running found-count), just for the hashtag-based discovery mode
// (2026-08-24) instead of tracked accounts.

interface HashtagRow extends Omit<TrackedHashtag, "active"> {
  active: boolean;
}

function mapHashtag(row: HashtagRow): TrackedHashtag {
  return { ...row, active: row.active ? 1 : 0 };
}

export async function listHashtags(): Promise<TrackedHashtag[]> {
  const pool = await getPool();
  const { rows } = await pool.query<HashtagRow>(
    "SELECT * FROM tracked_hashtags ORDER BY active DESC, tag ASC"
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

// Normalize a hashtag: strip leading '#', whitespace, lowercase. Deliberately
// does NOT "correct" spelling (e.g. "millionnaire" stays as typed) — this is
// exactly the string passed to the scraper actor and must match what Taha
// intends to search.
export function normalizeHashtag(input: string): string {
  return input.trim().replace(/^#/, "").trim().toLowerCase();
}

export async function addHashtag(rawTag: string): Promise<TrackedHashtag> {
  const tag = normalizeHashtag(rawTag);
  if (!tag) throw new Error("Empty hashtag");
  const pool = await getPool();
  await pool.query(
    "INSERT INTO tracked_hashtags (tag) VALUES ($1) ON CONFLICT (tag) DO NOTHING",
    [tag]
  );
  const { rows } = await pool.query<HashtagRow>(
    "SELECT * FROM tracked_hashtags WHERE tag = $1",
    [tag]
  );
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
