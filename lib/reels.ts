import { getDb } from "./db";
import type {
  Reel,
  ReelSource,
  ReelStatus,
  TranscriptStatus,
  RedLineFlag,
  VoiceoverStatus,
  Analysis,
} from "./types";

// Extract the Instagram shortcode from a reel/post URL, used for dedupe.
// e.g. https://www.instagram.com/reel/ABC123/ -> ABC123
export function extractShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : null;
}

export function listReels(status?: ReelStatus): Reel[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM reels WHERE status = ? ORDER BY date_found DESC")
      .all(status) as Reel[];
  }
  return db
    .prepare("SELECT * FROM reels ORDER BY date_found DESC")
    .all() as Reel[];
}

export function getReel(id: number): Reel | undefined {
  return getDb().prepare("SELECT * FROM reels WHERE id = ?").get(id) as
    | Reel
    | undefined;
}

export function findByShortcode(shortcode: string): Reel | undefined {
  return getDb()
    .prepare("SELECT * FROM reels WHERE shortcode = ?")
    .get(shortcode) as Reel | undefined;
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
export function insertReel(r: NewReel): Reel {
  const db = getDb();
  const shortcode = r.shortcode ?? extractShortcode(r.url);
  if (shortcode) {
    const existing = findByShortcode(shortcode);
    if (existing) return existing;
  }
  const info = db
    .prepare(
      `INSERT INTO reels
        (account_id, url, shortcode, views, source, transcript, transcript_status)
       VALUES (@account_id, @url, @shortcode, @views, @source, @transcript, @transcript_status)`
    )
    .run({
      account_id: r.account_id ?? null,
      url: r.url,
      shortcode: shortcode ?? null,
      views: r.views ?? null,
      source: r.source,
      transcript: r.transcript ?? null,
      transcript_status: r.transcript_status ?? "pending",
    });
  const id = Number(info.lastInsertRowid);
  // Manual adds arrive with the transcript already attached — advance the
  // status so they show up under the "transcribed" filter like scanned reels.
  if (r.transcript_status === "success" && r.transcript) {
    db.prepare(
      "UPDATE reels SET status = 'transcribed' WHERE id = ? AND status = 'new'"
    ).run(id);
  }
  return getReel(id)!;
}

function touch(id: number): void {
  getDb()
    .prepare("UPDATE reels SET updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function setTranscript(
  id: number,
  transcript: string | null,
  status: TranscriptStatus
): void {
  const db = getDb();
  db.prepare(
    "UPDATE reels SET transcript = ?, transcript_status = ? WHERE id = ?"
  ).run(transcript, status, id);
  // Advance status when a transcript first lands (don't regress later states).
  if (status === "success") {
    db.prepare(
      "UPDATE reels SET status = 'transcribed' WHERE id = ? AND status = 'new'"
    ).run(id);
  }
  touch(id);
}

export function setAdaptation(
  id: number,
  analysis: Analysis,
  adaptedScript: string,
  redLineFlag: RedLineFlag,
  redLineReason: string | null
): void {
  const db = getDb();
  db.prepare(
    `UPDATE reels
       SET analysis = ?, adapted_script = ?, red_line_flag = ?,
           red_line_reason = ?, status = 'adapted'
     WHERE id = ?`
  ).run(
    JSON.stringify(analysis),
    adaptedScript,
    redLineFlag,
    redLineReason,
    id
  );
  touch(id);
}

export function setVoiceover(
  id: number,
  status: VoiceoverStatus,
  filePath: string | null,
  error: string | null
): void {
  getDb()
    .prepare(
      "UPDATE reels SET voiceover_status = ?, voiceover_path = ?, voiceover_error = ? WHERE id = ?"
    )
    .run(status, filePath, error, id);
  touch(id);
}

export function updateEditable(
  id: number,
  fields: { transcript?: string; adapted_script?: string }
): void {
  const db = getDb();
  if (fields.transcript !== undefined) {
    db.prepare("UPDATE reels SET transcript = ? WHERE id = ?").run(
      fields.transcript,
      id
    );
  }
  if (fields.adapted_script !== undefined) {
    db.prepare("UPDATE reels SET adapted_script = ? WHERE id = ?").run(
      fields.adapted_script,
      id
    );
  }
  touch(id);
}

export function setStatus(id: number, status: ReelStatus): void {
  getDb().prepare("UPDATE reels SET status = ? WHERE id = ?").run(status, id);
  touch(id);
}

export function parseAnalysis(reel: Reel): Analysis | null {
  if (!reel.analysis) return null;
  try {
    return JSON.parse(reel.analysis) as Analysis;
  } catch {
    return null;
  }
}
