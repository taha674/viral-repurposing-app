import { getDb } from "./db";
import type { TrackedAccount } from "./types";

export function listAccounts(): TrackedAccount[] {
  return getDb()
    .prepare("SELECT * FROM tracked_accounts ORDER BY active DESC, handle ASC")
    .all() as TrackedAccount[];
}

export function getAccount(id: number): TrackedAccount | undefined {
  return getDb()
    .prepare("SELECT * FROM tracked_accounts WHERE id = ?")
    .get(id) as TrackedAccount | undefined;
}

// Normalize a handle: strip URL, leading @, trailing slashes, whitespace.
export function normalizeHandle(input: string): string {
  let h = input.trim();
  const m = h.match(/instagram\.com\/([^/?#]+)/i);
  if (m) h = m[1];
  h = h.replace(/^@/, "").replace(/\/+$/, "").trim();
  return h.toLowerCase();
}

export function addAccount(rawHandle: string): TrackedAccount {
  const handle = normalizeHandle(rawHandle);
  if (!handle) throw new Error("Empty handle");
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO tracked_accounts (platform, handle) VALUES ('instagram', ?)"
  ).run(handle);
  return db
    .prepare("SELECT * FROM tracked_accounts WHERE handle = ?")
    .get(handle) as TrackedAccount;
}

export function setAccountActive(id: number, active: boolean): void {
  getDb()
    .prepare("UPDATE tracked_accounts SET active = ? WHERE id = ?")
    .run(active ? 1 : 0, id);
}

export function removeAccount(id: number): void {
  getDb().prepare("DELETE FROM tracked_accounts WHERE id = ?").run(id);
}

export function markScanned(id: number, foundDelta: number): void {
  getDb()
    .prepare(
      `UPDATE tracked_accounts
         SET last_scanned_at = datetime('now'),
             reels_found_count = reels_found_count + ?
       WHERE id = ?`
    )
    .run(foundDelta, id);
}
