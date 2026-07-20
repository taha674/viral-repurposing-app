import { getPool } from "./db";

// Generic key/value settings store. Absence of a key means "use the code
// default" — callers decide what that default is.
export async function getSetting(key: string): Promise<string | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

export async function deleteSetting(key: string): Promise<void> {
  const pool = await getPool();
  await pool.query("DELETE FROM settings WHERE key = $1", [key]);
}
