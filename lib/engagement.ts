import { getPool } from "./db";
import { config } from "./config";
import type { Brand } from "./types";

// Engagement queue (launch content OS ticket 13): replies, comments and DMs
// Hermes drafts for the operator. The app never sends anything: the
// operator approves (on Telegram, quoted, or in the web app), pastes the
// text by hand, then it is marked sent. An approved draft left unsent for
// 48 hours reads as expired (a read-time check, not a job) and can no
// longer be marked sent. The row id is the stable number Hermes uses.

export type EngagementKind = "reply" | "comment" | "dm";
export const ENGAGEMENT_KINDS: EngagementKind[] = ["reply", "comment", "dm"];
export const ENGAGEMENT_PLATFORMS = ["reddit", "instagram", "tiktok", "youtube", "facebook", "x", "other"] as const;
export type EngagementPlatform = (typeof ENGAGEMENT_PLATFORMS)[number];
export type EngagementStatus = "draft" | "approved" | "sent" | "dropped" | "expired";

export interface Engagement {
  id: number;
  brand: Brand;
  reel_id: number | null;
  kind: EngagementKind;
  platform: EngagementPlatform;
  target_url: string;
  context: string;
  draft: string;
  approved_text: string | null;
  status: EngagementStatus;
  rationale: string;
  confirmation_note: string | null;
  drop_reason: string | null;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
}

const EXPIRY_HOURS = 48;

// "approved" older than 48h reads as "expired".
const SELECT = `SELECT id, brand, reel_id, kind, platform, target_url, context, draft, approved_text,
  CASE WHEN status = 'approved' AND approved_at < now() - interval '${EXPIRY_HOURS} hours'
       THEN 'expired' ELSE status END AS status,
  rationale, confirmation_note, drop_reason, created_at, approved_at, sent_at
  FROM engagement`;

async function get(id: number): Promise<Engagement> {
  const pool = await getPool();
  const { rows } = await pool.query<Engagement>(`${SELECT} WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error(`Engagement draft ${id} not found`);
  return rows[0];
}

export async function listEngagement(filter: { brand?: Brand; status?: EngagementStatus }): Promise<Engagement[]> {
  const pool = await getPool();
  const { rows } = await pool.query<Engagement>(
    `SELECT * FROM (${SELECT}) e
      WHERE ($1::text IS NULL OR brand = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY id`,
    [filter.brand ?? null, filter.status ?? null]
  );
  return rows;
}

// Daily draft caps per platform and bucket (comments and replies count
// together; DMs separately), from the platform-rules research
// (self-hifdh#225, reviewed 2026-10-18). Instagram DMs are replies to
// inbound DMs only; Reddit is r/Hifdh only (3-5 a day, the low end here);
// Facebook means groups. The TikTok DM and Facebook figures rest on
// reasoning only. X and other were not researched. A 0 means no drafts.
// Override with ENGAGEMENT_DAILY_CAPS="instagram:dm=10,reddit:comment=5".
type Bucket = "comment" | "dm";
const CAP_DEFAULTS: Record<EngagementPlatform, Record<Bucket, number>> = {
  instagram: { comment: 15, dm: 10 },
  tiktok: { comment: 15, dm: 5 },
  youtube: { comment: 15, dm: 0 },
  reddit: { comment: 3, dm: 0 },
  facebook: { comment: 5, dm: 0 },
  x: { comment: 5, dm: 0 },
  other: { comment: 5, dm: 0 },
};
const bucketOf = (kind: EngagementKind): Bucket => (kind === "dm" ? "dm" : "comment");

function capFor(platform: EngagementPlatform, bucket: Bucket): number {
  for (const pair of config.engagementDailyCaps.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k === `${platform}:${bucket}` && Number.isInteger(Number(v))) return Number(v);
  }
  return CAP_DEFAULTS[platform][bucket];
}

export async function draftEngagement(input: {
  brand: Brand;
  reel_id?: number | null;
  kind: EngagementKind;
  platform: EngagementPlatform;
  target_url: string;
  context: string;
  draft: string;
  rationale: string;
}): Promise<Engagement> {
  // ponytail: count-then-insert, no lock; two concurrent drafts could both pass. One agent drafts at a time today.
  const pool = await getPool();
  const bucket = bucketOf(input.kind);
  const cap = capFor(input.platform, bucket);
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagement
      WHERE platform = $1 AND brand = $2 AND created_at >= date_trunc('day', now())
        AND (kind = 'dm') = $3`,
    [input.platform, input.brand, bucket === "dm"]
  );
  if (rows[0].n >= cap) {
    throw new Error(
      `Daily ${input.platform} ${bucket} draft cap reached (${rows[0].n}/${cap}). Do not draft more today; tell the operator.`
    );
  }
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO engagement (brand, reel_id, kind, platform, target_url, context, draft, rationale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.brand, input.reel_id ?? null, input.kind, input.platform, input.target_url, input.context, input.draft, input.rationale]
  );
  return get(ins.rows[0].id);
}

// The operator's approval. `text` is the wording they approved (edited or
// not); the original draft is kept beside it.
export async function approveEngagement(id: number, text: string | null, confirmationNote: string | null): Promise<Engagement> {
  const e = await get(id);
  if (e.status !== "draft") throw new Error(`Draft ${id} is ${e.status}, not a draft.`);
  const pool = await getPool();
  await pool.query(
    "UPDATE engagement SET status = 'approved', approved_text = $2, confirmation_note = $3, approved_at = now() WHERE id = $1",
    [id, (text ?? e.draft).trim(), confirmationNote]
  );
  return get(id);
}

export async function dropEngagement(id: number, reason: string): Promise<Engagement> {
  const e = await get(id);
  if (e.status === "sent" || e.status === "dropped") throw new Error(`Draft ${id} is already ${e.status}.`);
  const pool = await getPool();
  await pool.query("UPDATE engagement SET status = 'dropped', drop_reason = $2 WHERE id = $1", [id, reason]);
  return get(id);
}

export async function markSent(id: number): Promise<Engagement> {
  const e = await get(id);
  if (e.status === "expired") {
    throw new Error(`Draft ${id} was approved over ${EXPIRY_HOURS} hours ago and expired unsent. Draft it again if it still applies.`);
  }
  if (e.status !== "approved") throw new Error(`Draft ${id} is ${e.status}; only an approved draft can be marked sent.`);
  const pool = await getPool();
  await pool.query("UPDATE engagement SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
  return get(id);
}
