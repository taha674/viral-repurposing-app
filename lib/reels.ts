import { getPool } from "./db";
import type {
  Reel,
  ReelSource,
  ReelStatus,
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

export interface NewReel {
  account_id?: number | null;
  url: string;
  shortcode?: string | null;
  views?: number | null;
  source: ReelSource;
  transcript?: string | null;
  transcript_status?: TranscriptStatus;
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
      (account_id, url, shortcode, views, source, transcript, transcript_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      r.account_id ?? null,
      r.url,
      shortcode ?? null,
      r.views ?? null,
      r.source,
      r.transcript ?? null,
      r.transcript_status ?? "pending",
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
  status: TranscriptStatus
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    "UPDATE reels SET transcript = $1, transcript_status = $2 WHERE id = $3",
    [transcript, status, id]
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

// Only ever called for the two human-decision transitions (approve/archive —
// see app/page.tsx). Clears the red-line flag/reason on every call: the flag
// is a first-pass hint for the human reviewer, not a verdict, and taking a
// manual status action on the reel IS that human review. Leaving a stale
// "needs_review"/"rejected" flag on an already-approved reel is confusing,
// not a compliance safeguard — the human already made the call.
export async function setStatus(id: number, status: ReelStatus): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE reels
       SET status = $1, red_line_flag = 'none', red_line_reason = NULL
     WHERE id = $2`,
    [status, id]
  );
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
