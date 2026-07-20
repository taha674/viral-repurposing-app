import { getPool } from "./db";
import type { TrackedAccount } from "./types";

// Postgres stores `active` as BOOLEAN; the app-facing type keeps the prior
// 0/1 shape so existing frontend logic (`a.active === 0`, etc.) is unchanged.
interface AccountRow extends Omit<TrackedAccount, "active"> {
  active: boolean;
}

function mapAccount(row: AccountRow): TrackedAccount {
  return { ...row, active: row.active ? 1 : 0 };
}

export async function listAccounts(): Promise<TrackedAccount[]> {
  const pool = await getPool();
  const { rows } = await pool.query<AccountRow>(
    "SELECT * FROM tracked_accounts ORDER BY active DESC, handle ASC"
  );
  return rows.map(mapAccount);
}

export async function getAccount(id: number): Promise<TrackedAccount | undefined> {
  const pool = await getPool();
  const { rows } = await pool.query<AccountRow>(
    "SELECT * FROM tracked_accounts WHERE id = $1",
    [id]
  );
  return rows[0] ? mapAccount(rows[0]) : undefined;
}

// Normalize a handle: strip URL, leading @, trailing slashes, whitespace.
export function normalizeHandle(input: string): string {
  let h = input.trim();
  const m = h.match(/instagram\.com\/([^/?#]+)/i);
  if (m) h = m[1];
  h = h.replace(/^@/, "").replace(/\/+$/, "").trim();
  return h.toLowerCase();
}

export async function addAccount(rawHandle: string): Promise<TrackedAccount> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) throw new Error("Empty handle");
  const pool = await getPool();
  await pool.query(
    "INSERT INTO tracked_accounts (platform, handle) VALUES ('instagram', $1) ON CONFLICT (handle) DO NOTHING",
    [handle]
  );
  const { rows } = await pool.query<AccountRow>(
    "SELECT * FROM tracked_accounts WHERE handle = $1",
    [handle]
  );
  return mapAccount(rows[0]);
}

export async function setAccountActive(id: number, active: boolean): Promise<void> {
  const pool = await getPool();
  await pool.query("UPDATE tracked_accounts SET active = $1 WHERE id = $2", [
    active,
    id,
  ]);
}

export async function removeAccount(id: number): Promise<void> {
  const pool = await getPool();
  await pool.query("DELETE FROM tracked_accounts WHERE id = $1", [id]);
}

export async function markScanned(id: number, foundDelta: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE tracked_accounts
       SET last_scanned_at = now(),
           reels_found_count = reels_found_count + $1
     WHERE id = $2`,
    [foundDelta, id]
  );
}
