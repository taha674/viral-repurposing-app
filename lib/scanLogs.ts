import { getPool } from "./db";
import type { ScanLog } from "./types";

export async function listScanLogs(limit = 100): Promise<ScanLog[]> {
  const pool = await getPool();
  const { rows } = await pool.query<ScanLog>(
    "SELECT * FROM scan_logs ORDER BY run_at DESC LIMIT $1",
    [limit]
  );
  return rows;
}
