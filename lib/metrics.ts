import { getPool } from "./db";
import { getReel } from "./reels";
import { fetchReel } from "./treg";
import type { Brand } from "./types";

// Metrics (launch content OS ticket 09). One row per reading, so results
// build up week by week; only posted items take readings. The per-hook
// summary is computed on read from each item's latest reading.

export interface MetricsInput {
  platform: string;
  read_at?: string;
  views?: number | null;
  three_second_rate?: number | null; // 0..1
  saves?: number | null;
  comments?: number | null;
  shares?: number | null;
}

export async function recordMetrics(reelId: number, m: MetricsInput, source: "manual" | "treg" = "manual") {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.status !== "posted") {
    throw new Error(`Metrics attach only to posted items; reel ${reelId} is "${reel.status}".`);
  }
  if (m.three_second_rate != null && (m.three_second_rate < 0 || m.three_second_rate > 1)) {
    throw new Error("three_second_rate is a fraction between 0 and 1.");
  }
  const at = m.read_at ? new Date(m.read_at) : new Date();
  if (Number.isNaN(at.getTime())) throw new Error(`Not a date-time: ${m.read_at}`);
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO metrics (reel_id, platform, read_at, views, three_second_rate, saves, comments, shares, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [reelId, m.platform, at.toISOString(), m.views ?? null, m.three_second_rate ?? null, m.saves ?? null, m.comments ?? null, m.shares ?? null, source]
  );
  return rows[0];
}

export async function listMetrics(reelId: number) {
  const pool = await getPool();
  const { rows } = await pool.query("SELECT * FROM metrics WHERE reel_id = $1 ORDER BY read_at", [reelId]);
  return rows;
}

// Per hook (A, B, C, and untagged), over posted items: how many, the median
// of each item's latest views and 3-second rate, and total saves and
// comments. Plus month-to-date paid spend: treg dollars from the
// provider_spend ledger, and agent paid calls (Claude, ElevenLabs) by count,
// since those are not billed per call in dollars here. Spend is for the
// whole app, not per brand: the ledger has no brand column.
export async function hookSummary(brand?: Brand) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (m.reel_id, m.platform) m.*
         FROM metrics m ORDER BY m.reel_id, m.platform, m.read_at DESC
     ), per_item AS (
       SELECT r.id, COALESCE(r.hook, 'untagged') AS hook,
              SUM(l.views) AS views, AVG(l.three_second_rate) AS three_second_rate,
              SUM(l.saves) AS saves, SUM(l.comments) AS comments
         FROM reels r LEFT JOIN latest l ON l.reel_id = r.id
        WHERE r.status = 'posted' AND ($1::text IS NULL OR r.brand = $1)
        GROUP BY r.id
     )
     SELECT hook,
            count(*)::int AS items_posted,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY views) AS median_views,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY three_second_rate) AS median_three_second_rate,
            COALESCE(SUM(saves), 0)::int AS total_saves,
            COALESCE(SUM(comments), 0)::int AS total_comments
       FROM per_item GROUP BY hook ORDER BY hook`,
    [brand ?? null]
  );
  const spend = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(cost_micro), 0) FROM provider_spend WHERE at >= date_trunc('month', now()))::bigint AS treg_micro,
       (SELECT count(*) FROM agent_actions WHERE at >= date_trunc('month', now()) AND ok
          AND tool IN ('adapt_reel', 'generate_voiceover', 'generate_publish_pack', 'retry_transcript', 'add_reel'))::int AS paid_calls`
  );
  return {
    hooks: rows.map((r) => ({
      ...r,
      median_views: r.median_views === null ? null : Number(r.median_views),
      median_three_second_rate: r.median_three_second_rate === null ? null : Number(r.median_three_second_rate),
    })),
    month_to_date: { treg_usd: Number(spend.rows[0].treg_micro) / 1e6, agent_paid_calls: spend.rows[0].paid_calls },
  };
}

// Weekly cron: public counts for every posted item's Instagram link, read
// through treg (paid, ~$0.0015 a link, inside TREG_DAILY_SPEND_CAP_USD).
// One failure skips that item. Saves, shares and 3-second rate need the
// account's own Graph insights (not wired yet: needs the hifz account
// registered as a treg tool), so they stay with record_metrics.
export async function refreshPostedMetrics(): Promise<{ read: number; failed: number }> {
  const pool = await getPool();
  const { rows } = await pool.query<{ reel_id: number; url: string }>(
    `SELECT pl.reel_id, pl.url FROM post_links pl JOIN reels r ON r.id = pl.reel_id
      WHERE r.status = 'posted' AND pl.platform = 'instagram' ORDER BY pl.reel_id`
  );
  let read = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const s = await fetchReel(row.url);
      if (!s) throw new Error("no answer");
      await recordMetrics(row.reel_id, { platform: "instagram", views: s.views, comments: s.comments }, "treg");
      read += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[metrics] reel ${row.reel_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { read, failed };
}
