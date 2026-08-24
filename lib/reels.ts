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
      (account_id, hashtag_id, url, shortcode, views, source, transcript, transcript_status, thumbnail_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

export async function setTranscript(
  id: number,
  transcript: string | null,
  status: TranscriptStatus,
  // Opportunistic backfill: a re-pull hits Apify again anyway, so if that
  // response carries a thumbnail this reel didn't have yet (e.g. it was
  // scraped before thumbnail capture existed), save it too. Never clobbers
  // an existing thumbnail with null on a failed/thumbnail-less re-pull.
  thumbnailUrl?: string | null
): Promise<void> {
  const pool = await getPool();
  if (thumbnailUrl) {
    await pool.query(
      "UPDATE reels SET transcript = $1, transcript_status = $2, thumbnail_url = $3 WHERE id = $4",
      [transcript, status, thumbnailUrl, id]
    );
  } else {
    await pool.query(
      "UPDATE reels SET transcript = $1, transcript_status = $2 WHERE id = $3",
      [transcript, status, id]
    );
  }
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

export async function updateEditable(
  id: number,
  fields: { transcript?: string; adapted_script?: string }
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
