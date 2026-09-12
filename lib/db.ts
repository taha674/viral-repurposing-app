import { Pool, types } from "pg";

// Postgres store (Railway-managed). Schema mirrors ../reference-inputs.md / PRD §6
// and the prior local-SQLite shape as closely as possible.

// node-postgres parses TIMESTAMPTZ (OID 1184) into a JS Date object by
// default. Every timestamp column here (last_scanned_at, date_found,
// created_at, updated_at, run_at) is typed as `string` throughout the
// codebase — a holdover from the SQLite days where datetime('now') really
// was a string — and callers rely on that (e.g. scanAccount()'s
// `since.slice(0, 10)`). Registering a passthrough parser keeps those
// columns as the raw string Postgres sends over the wire, matching what
// every type and caller already assumes, instead of silently becoming Date
// objects that break `.slice()` and JSX rendering.
types.setTypeParser(1114, (val) => val); // TIMESTAMP (no tz), just in case
types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ

// Seed accounts from reference-inputs.md (Instagram-only MVP).
const SEED_HANDLES = [
  "walt.ashford.us",
  "marktilbury",
  "thomas_bennett_us",
  "giovannirossini_x",
  "william_maldano",
  "sheikhtariqq",
  "richard_hale_",
  "thedavidchen888",
  "lastconsigliere",
  "sheikhmanso",
  "donrico.scimatch",
  "therajpatels",
];

// Seed hashtags for hashtag-based discovery (2026-08-24). Taha starts with
// these three; more are added from the Discovery Sources page as needed.
const SEED_HASHTAGS = ["usa", "millionnaire", "wealth"];

let _pool: Pool | null = null;
let _ready: Promise<void> | null = null;

function isLocalHost(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Provision a Postgres database and set DATABASE_URL " +
        "(Railway sets this automatically when you attach its Postgres addon)."
    );
  }
  return new Pool({
    connectionString,
    // Railway's Postgres (and most managed hosts) require SSL for
    // non-localhost connections but use a self-signed cert chain.
    ssl: isLocalHost(connectionString) ? undefined : { rejectUnauthorized: false },
  });
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id                SERIAL PRIMARY KEY,
      platform          TEXT NOT NULL DEFAULT 'instagram',
      handle            TEXT NOT NULL UNIQUE,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      last_scanned_at   TIMESTAMPTZ,
      reels_found_count INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tracked_hashtags (
      id                SERIAL PRIMARY KEY,
      tag               TEXT NOT NULL UNIQUE,
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      last_scanned_at   TIMESTAMPTZ,
      reels_found_count INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reels (
      id                SERIAL PRIMARY KEY,
      account_id        INTEGER REFERENCES tracked_accounts(id) ON DELETE SET NULL,
      platform          TEXT NOT NULL DEFAULT 'instagram',
      url               TEXT NOT NULL,
      shortcode         TEXT UNIQUE,
      views             INTEGER,
      date_found        TIMESTAMPTZ NOT NULL DEFAULT now(),
      source            TEXT NOT NULL,
      transcript        TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      analysis          TEXT,
      adapted_script    TEXT,
      red_line_flag     TEXT NOT NULL DEFAULT 'none',
      red_line_reason   TEXT,
      voiceover_status  TEXT NOT NULL DEFAULT 'none',
      voiceover_path    TEXT,
      voiceover_error   TEXT,
      voiceover_alignment JSONB,
      captions_status   TEXT NOT NULL DEFAULT 'none',
      captions_video_path TEXT,
      captions_error    TEXT,
      source_caption    TEXT,
      source_hashtags   JSONB,
      publish_pack      JSONB,
      publish_pack_status TEXT NOT NULL DEFAULT 'none',
      publish_pack_error  TEXT,
      status            TEXT NOT NULL DEFAULT 'new',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS scan_logs (
      id          SERIAL PRIMARY KEY,
      run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      account_id  INTEGER,
      handle      TEXT NOT NULL,
      status      TEXT NOT NULL,
      message     TEXT NOT NULL DEFAULT '',
      reels_found INTEGER NOT NULL DEFAULT 0
    );

    -- Simple key/value store for user-editable settings (e.g. a custom
    -- adaptation system prompt). Absence of a key means "use the code default".
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_reels_status ON reels(status);
    CREATE INDEX IF NOT EXISTS idx_reels_account ON reels(account_id);

    -- CREATE TABLE IF NOT EXISTS above is a no-op against the live prod
    -- table, so new columns added after the initial migration need an
    -- explicit ALTER here too.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS voiceover_alignment JSONB;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS captions_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS captions_video_path TEXT;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS captions_error TEXT;

    -- Kanban revamp (2026-08-23): the HeyGen upload is now its own stage
    -- (before, burnCaptions() took the upload and burned in one call), and
    -- every reel's files are named from a stable slug (lib/naming.ts)
    -- instead of "{id}_{date}/voiceover.mp3".
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS source_video_path TEXT;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS slug TEXT;

    -- Reject-from-any-stage / restore-to-origin (2026-08-24): remembers which
    -- status a reel was in right before it got rejected, so restoring it from
    -- the Rejected tray puts it back where it actually came from instead of
    -- always assuming Scraped.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS previous_status TEXT;

    -- Small preview thumbnail (2026-08-24), captured from Apify's scrape
    -- response when available. Instagram's CDN URLs are signed/expiring, so
    -- this is best-effort — the UI hides the image if it 404s later.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

    -- Hashtag-based discovery (2026-08-24): a second discovery mode alongside
    -- tracked accounts, sharing the reels table and the scan_logs table
    -- (hashtag scan_logs rows carry account_id NULL and handle = '#tag').
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS hashtag_id INTEGER REFERENCES tracked_hashtags(id) ON DELETE SET NULL;

    -- Publish pack (2026-09-12): the source post's own caption + hashtags,
    -- captured from the scrape response we already pay for, and the
    -- red-line-filtered caption/hashtag/cover-text suggestions generated
    -- from them. source_caption/source_hashtags are populated on NEW scrapes
    -- only — pre-existing rows stay NULL, and every consumer handles that.
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS source_caption TEXT;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS source_hashtags JSONB;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS publish_pack JSONB;
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS publish_pack_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE reels ADD COLUMN IF NOT EXISTS publish_pack_error TEXT;
  `);

  await seedAccounts(pool);
  await seedHashtags(pool);
  await backfillKanbanStatuses(pool);
}

// One-time backfill for reels that finished under the old single-page UI:
// without this they'd resurface in the Audio column since "approved" used
// to mean "done", and the "video"/"captioned" statuses didn't exist yet.
// Idempotent (the WHERE clause only ever matches pre-revamp rows once) and
// safe to re-run every process start.
async function backfillKanbanStatuses(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE reels SET status = 'captioned'
       WHERE status = 'approved' AND captions_status = 'success'`
  );
}

// One-time seed of the tracked-account list. Idempotent: only runs when the
// table is empty, so removing an account in the UI won't resurrect it.
async function seedAccounts(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM tracked_accounts"
  );
  if (Number(rows[0].n) > 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const handle of SEED_HANDLES) {
      await client.query(
        "INSERT INTO tracked_accounts (platform, handle) VALUES ('instagram', $1)",
        [handle]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// One-time seed of the tracked-hashtag list. Idempotent: only runs when the
// table is empty, so removing a hashtag in the UI won't resurrect it.
async function seedHashtags(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM tracked_hashtags"
  );
  if (Number(rows[0].n) > 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const tag of SEED_HASHTAGS) {
      await client.query(
        "INSERT INTO tracked_hashtags (tag) VALUES ($1)",
        [tag]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Returns a ready-to-query pool; schema creation + seeding run once per process.
export async function getPool(): Promise<Pool> {
  if (!_pool) _pool = createPool();
  if (!_ready) _ready = ensureSchema(_pool);
  await _ready;
  return _pool;
}
