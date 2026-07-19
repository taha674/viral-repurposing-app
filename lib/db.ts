import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Local SQLite store. Schema mirrors ../reference-inputs.md / PRD §6.
// The Postgres port (Railway) is a later phase; keep this shape close to it.

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

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

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      platform          TEXT NOT NULL DEFAULT 'instagram',
      handle            TEXT NOT NULL UNIQUE,
      active            INTEGER NOT NULL DEFAULT 1,
      last_scanned_at   TEXT,
      reels_found_count INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reels (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id        INTEGER REFERENCES tracked_accounts(id) ON DELETE SET NULL,
      platform          TEXT NOT NULL DEFAULT 'instagram',
      url               TEXT NOT NULL,
      shortcode         TEXT UNIQUE,
      views             INTEGER,
      date_found        TEXT NOT NULL DEFAULT (datetime('now')),
      source            TEXT NOT NULL,
      transcript        TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      analysis          TEXT,
      adapted_script    TEXT,
      red_line_flag     TEXT NOT NULL DEFAULT 'none',
      red_line_reason   TEXT,
      status            TEXT NOT NULL DEFAULT 'new',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at      TEXT NOT NULL DEFAULT (datetime('now')),
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reels_status ON reels(status);
    CREATE INDEX IF NOT EXISTS idx_reels_account ON reels(account_id);
  `);

  migrateVoiceoverColumns(db);
  seedAccounts(db);

  _db = db;
  return db;
}

// Additive migration for the ElevenLabs voiceover step. Guarded on existing
// columns so it's safe to run against an already-populated local DB file.
function migrateVoiceoverColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(reels)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (!cols.includes("voiceover_status")) {
    db.exec(
      "ALTER TABLE reels ADD COLUMN voiceover_status TEXT NOT NULL DEFAULT 'none'"
    );
  }
  if (!cols.includes("voiceover_path")) {
    db.exec("ALTER TABLE reels ADD COLUMN voiceover_path TEXT");
  }
  if (!cols.includes("voiceover_error")) {
    db.exec("ALTER TABLE reels ADD COLUMN voiceover_error TEXT");
  }
}

// One-time seed of the tracked-account list. Idempotent: only runs when the
// table is empty, so removing an account in the UI won't resurrect it.
function seedAccounts(db: Database.Database) {
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM tracked_accounts").get() as {
      n: number;
    }
  ).n;
  if (count > 0) return;

  const insert = db.prepare(
    "INSERT INTO tracked_accounts (platform, handle) VALUES ('instagram', ?)"
  );
  const tx = db.transaction((handles: string[]) => {
    for (const h of handles) insert.run(h);
  });
  tx(SEED_HANDLES);
}
