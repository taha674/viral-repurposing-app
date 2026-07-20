import { Pool } from "pg";

// Postgres store (Railway-managed). Schema mirrors ../reference-inputs.md / PRD §6
// and the prior local-SQLite shape as closely as possible.

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
  `);

  await seedAccounts(pool);
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

// Returns a ready-to-query pool; schema creation + seeding run once per process.
export async function getPool(): Promise<Pool> {
  if (!_pool) _pool = createPool();
  if (!_ready) _ready = ensureSchema(_pool);
  await _ready;
  return _pool;
}
