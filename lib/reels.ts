import { getPool } from "./db";
import type {
  Reel,
  ReelSource,
  ReelStatus,
  ReelSummary,
  TranscriptStatus,
  RedLineFlag,
  VoiceoverStatus,
  VoiceoverAlignment,
  CaptionsStatus,
  Analysis,
  PublishPack,
  PublishPackStatus,
} from "./types";

// Extract the Instagram shortcode from a reel/post URL, used for dedupe.
// e.g. https://www.instagram.com/reel/ABC123/ -> ABC123
export function extractShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : null;
}

export async function listReels(status?: ReelStatus): Promise<Reel[]> {
  const pool = await getPool();
  if (status) {
    const { rows } = await pool.query<Reel>(
      "SELECT * FROM reels WHERE status = $1 ORDER BY date_found DESC",
      [status]
    );
    return rows;
  }
  const { rows } = await pool.query<Reel>(
    "SELECT * FROM reels ORDER BY date_found DESC"
  );
  return rows;
}

// Board payload: every reel at once, minus the fields that would make that
// expensive — transcript, analysis JSON, and especially voiceover_alignment
// (three parallel per-character arrays). A short transcript excerpt is
// computed in SQL instead of shipping the whole thing. The stage popup
// fetches the full Reel separately via GET /api/reels/[id] when opened.
const SUMMARY_COLUMNS = `
  id, account_id, hashtag_id, platform, url, shortcode, views, date_found, source,
  transcript_status, adapted_script, red_line_flag, red_line_reason,
  voiceover_status, voiceover_path, voiceover_error,
  captions_status, captions_video_path, captions_error,
  source_hashtags, publish_pack_status, publish_pack_error,
  source_video_path, slug, status, previous_status, thumbnail_url,
  created_at, updated_at,
  (transcript IS NOT NULL) AS has_transcript,
  LEFT(transcript, 200) AS transcript_excerpt
`;

export async function listReelSummaries(): Promise<ReelSummary[]> {
  const pool = await getPool();
  const { rows } = await pool.query<ReelSummary>(
    `SELECT ${SUMMARY_COLUMNS} FROM reels ORDER BY date_found DESC`
  );
  return rows;
}

export async function getReel(id: number): Promise<Reel | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<Reel>("SELECT * FROM reels WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

export async function findByShortcode(
  shortcode: string
): Promise<Reel | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<Reel>(
    "SELECT * FROM reels WHERE shortcode = $1",
    [shortcode]
  );
  return rows[0];
}

// Collision check for slug minting (lib/naming.ts) — excludes the reel's own
// id so re-checking an already-slugged reel doesn't flag itself.
export async function findBySlug(
  slug: string,
  excludeId: number
): Promise<Reel | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<Reel>(
    "SELECT * FROM reels WHERE slug = $1 AND id != $2",
    [slug, excludeId]
  );
  return rows[0];
}

export interface NewReel {
  account_id?: number | null;
  hashtag_id?: number | null;
  url: string;
  shortcode?: string | null;
  views?: number | null;
  source: ReelSource;
  transcript?: string | null;
  transcript_status?: TranscriptStatus;
  thumbnail_url?: string | null;
  // The source post's own caption + hashtags, straight off the scrape.
  source_caption?: string | null;
  source_hashtags?: string[] | null;
}

// Insert a reel. Returns the existing row if the shortcode is already present
// (dedupe: a reel can be both manually added and later caught by a scan).
export async function insertReel(r: NewReel): Promise<Reel> {
  const pool = await getPool();
  const shortcode = r.shortcode ?? extractShortcode(r.url);
  if (shortcode) {
    const existing = await findByShortcode(shortcode);
    if (existing) return existing;
  }
  const { rows } = await pool.query<Reel>(
    `INSERT INTO reels
      (account_id, hashtag_id, url, shortcode, views, source, transcript, transcript_status,
       thumbnail_url, source_caption, source_hashtags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      r.account_id ?? null,
      r.hashtag_id ?? null,
      r.url,
      shortcode ?? null,
      r.views ?? null,
      r.source,
      r.transcript ?? null,
      r.transcript_status ?? "pending",
      r.thumbnail_url ?? null,
      r.source_caption ?? null,
      // An empty tag list is stored as NULL, not [], so "this reel genuinely
      // has no hashtags" and "we never captured them" don't have to be told
      // apart by length — both read as absent, which is what the UI shows.
      r.source_hashtags?.length ? JSON.stringify(r.source_hashtags) : null,
    ]
  );
  const id = rows[0].id;
  // Manual adds arrive with the transcript already attached — advance the
  // status so they show up under the "transcribed" filter like scanned reels.
  if (r.transcript_status === "success" && r.transcript) {
    await pool.query(
      "UPDATE reels SET status = 'transcribed' WHERE id = $1 AND status = 'new'",
      [id]
    );
  }
  return (await getReel(id))!;
}

async function touch(id: number): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE reels SET updated_at = now() WHERE id = $1", [id]);
}

// Fields a transcript re-pull can opportunistically backfill. A re-pull hits
// Apify again anyway, so anything useful in that response gets saved even
// though the transcript is what we asked for. Each is written only when
// present: a failed or field-less re-pull never clobbers what's on record
// with null.
export interface TranscriptExtras {
  thumbnailUrl?: string | null;
  sourceCaption?: string | null;
  sourceHashtags?: string[] | null;
}

export async function setTranscript(
  id: number,
  transcript: string | null,
  status: TranscriptStatus,
  extras: TranscriptExtras = {}
): Promise<void> {
  const pool = await getPool();
  // Built as a list so adding another backfill field doesn't mean another
  // branch of the old if/else (which already only handled one field).
  const sets = ["transcript = $1", "transcript_status = $2"];
  const values: unknown[] = [transcript, status];
  const push = (col: string, value: unknown) => {
    values.push(value);
    sets.push(`${col} = $${values.length}`);
  };
  if (extras.thumbnailUrl) push("thumbnail_url", extras.thumbnailUrl);
  if (extras.sourceCaption) push("source_caption", extras.sourceCaption);
  if (extras.sourceHashtags?.length) {
    push("source_hashtags", JSON.stringify(extras.sourceHashtags));
  }
  values.push(id);
  await pool.query(
    `UPDATE reels SET ${sets.join(", ")} WHERE id = $${values.length}`,
    values
  );
  // Advance status when a transcript first lands (don't regress later states).
  if (status === "success") {
    await pool.query(
      "UPDATE reels SET status = 'transcribed' WHERE id = $1 AND status = 'new'",
      [id]
    );
  }
  await touch(id);
}

export async function setAdaptation(
  id: number,
  analysis: Analysis,
  adaptedScript: string,
  redLineFlag: RedLineFlag,
  redLineReason: string | null
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE reels
       SET analysis = $1, adapted_script = $2, red_line_flag = $3,
           red_line_reason = $4, status = 'adapted'
     WHERE id = $5`,
    [JSON.stringify(analysis), adaptedScript, redLineFlag, redLineReason, id]
  );
  await touch(id);
}

export async function setVoiceover(
  id: number,
  status: VoiceoverStatus,
  filePath: string | null,
  error: string | null,
  alignment?: VoiceoverAlignment | null
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE reels
       SET voiceover_status = $1, voiceover_path = $2, voiceover_error = $3,
           voiceover_alignment = $4
     WHERE id = $5`,
    [status, filePath, error, alignment ? JSON.stringify(alignment) : null, id]
  );
  await touch(id);
}

export async function setCaptions(
  id: number,
  status: CaptionsStatus,
  videoPath: string | null,
  error: string | null
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    "UPDATE reels SET captions_status = $1, captions_video_path = $2, captions_error = $3 WHERE id = $4",
    [status, videoPath, error, id]
  );
  await touch(id);
}

// Suggested caption / hashtags / cover text. Same shape as setVoiceover and
// setCaptions: one status column, one payload, one error string, so a failed
// run is visible in the UI instead of just vanishing. Deliberately does NOT
// touch `status` — the pack is metadata hanging off the reel, not a board
// position, so generating one never moves a card between columns.
export async function setPublishPack(
  id: number,
  status: PublishPackStatus,
  pack: PublishPack | null,
  error: string | null
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE reels
       SET publish_pack_status = $1, publish_pack = $2, publish_pack_error = $3
     WHERE id = $4`,
    [status, pack ? JSON.stringify(pack) : null, error, id]
  );
  await touch(id);
}

// The finished HeyGen/edited video, uploaded before the subtitle burn.
export async function setSourceVideo(id: number, path: string): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE reels SET source_video_path = $1 WHERE id = $2", [
    path,
    id,
  ]);
  await touch(id);
}

// Minted once, on accept (see service.ts#acceptReel). Never re-derived from
// a later transcript edit — the slug is the stable stem every file this reel
// produces is named from (lib/naming.ts).
export async function setSlug(id: number, slug: string): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE reels SET slug = $1 WHERE id = $2", [slug, id]);
  await touch(id);
}

// Null out every on-disk pointer for a reel whose files have been deleted
// from the volume (see lib/retention.ts — the archive purge). The paths and
// the alignment blob are the only columns tied to files; the transcript,
// adapted script and publish pack are DB text and deliberately survive, so
// an archived reel is still a readable record of what was produced.
//
// voiceover_status/captions_status go back to "none" rather than staying
// "success": leaving them successful would make the UI offer download and
// stream controls for files that no longer exist.
export async function clearMediaPaths(id: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE reels
       SET voiceover_status = 'none', voiceover_path = NULL,
           voiceover_error = NULL, voiceover_alignment = NULL,
           source_video_path = NULL,
           captions_status = 'none', captions_video_path = NULL,
           captions_error = NULL
     WHERE id = $1`,
    [id]
  );
  await touch(id);
}

export async function updateEditable(
  id: number,
  fields: {
    transcript?: string;
    adapted_script?: string;
    // The whole pack, re-saved after the operator edits the caption or
    // prunes the tag list. Sent and stored as one object rather than field
    // by field: it's a single small JSONB blob and a partial write would
    // leave the rationale describing a caption that no longer exists.
    publish_pack?: PublishPack;
  }
): Promise<void> {
  const pool = await getPool();
  if (fields.transcript !== undefined) {
    await pool.query("UPDATE reels SET transcript = $1 WHERE id = $2", [
      fields.transcript,
      id,
    ]);
  }
  if (fields.adapted_script !== undefined) {
    await pool.query("UPDATE reels SET adapted_script = $1 WHERE id = $2", [
      fields.adapted_script,
      id,
    ]);
  }
  if (fields.publish_pack !== undefined) {
    await pool.query("UPDATE reels SET publish_pack = $1 WHERE id = $2", [
      JSON.stringify(fields.publish_pack),
      id,
    ]);
  }
  await touch(id);
}

// Only for the human-decision transitions where the operator is genuinely
// resolving the red-line flag: Approve (adaptation -> approved) and Reject
// (scraped -> rejected). Clears the red-line flag/reason on every call: the
// flag is a first-pass hint for the human reviewer, not a verdict, and
// taking one of these two actions on the reel IS that human review. Leaving
// a stale "needs_review"/"rejected" flag on an already-approved reel is
// confusing, not a compliance safeguard — the human already made the call.
//
// Every other board transition (accept, send-to-video, burn, archive, tray
// restores) goes through advanceStatus() below instead, which leaves the
// flag untouched — those moves don't represent the operator resolving it.
export async function setStatus(id: number, status: ReelStatus): Promise<void> {
  const pool = await getPool();
  if (status === "rejected") {
    // Remember what the reel's status was right before the reject, so
    // restoreReel() can send it back to that same column instead of always
    // assuming Scraped. `status` on the right-hand side reads the pre-update
    // row value — this is one atomic UPDATE, not a read-then-write race.
    await pool.query(
      `UPDATE reels
         SET previous_status = status, status = $1,
             red_line_flag = 'none', red_line_reason = NULL
       WHERE id = $2`,
      [status, id]
    );
  } else {
    await pool.query(
      `UPDATE reels
         SET status = $1, red_line_flag = 'none', red_line_reason = NULL
       WHERE id = $2`,
      [status, id]
    );
  }
  await touch(id);
}

// Board transitions that are not a human resolving the red-line flag — see
// setStatus's comment for which two transitions ARE that and use it instead.
export async function advanceStatus(id: number, status: ReelStatus): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE reels SET status = $1 WHERE id = $2", [status, id]);
  await touch(id);
}

export function parseAnalysis(reel: Reel): Analysis | null {
  if (!reel.analysis) return null;
  try {
    return JSON.parse(reel.analysis) as Analysis;
  } catch {
    return null;
  }
}
