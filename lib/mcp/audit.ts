import { config } from "../config";
import { getPool } from "../db";

// Every mutating MCP tool call goes through withAudit: it is the audit trail
// (who/what/why, per the operator-delegation rails in CLAUDE.md) and the
// source of truth for the daily spend caps.

export type ToolKind = "write" | "paid" | "scan";

// Attempts count against the cap whether they succeed or fail — a failed
// paid call has usually still been billed, and a retry loop must not be able
// to sidestep the cap by failing.
async function countToday(tools: string[]): Promise<number> {
  const pool = await getPool();
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_actions
      WHERE tool = ANY($1) AND at >= date_trunc('day', now())`,
    [tools]
  );
  return Number(rows[0]?.n ?? 0);
}

const PAID_TOOLS = ["retry_transcript", "adapt_reel", "generate_voiceover", "generate_publish_pack", "add_reel"];
const SCAN_TOOLS = ["run_scan"];

async function enforceCap(kind: ToolKind): Promise<void> {
  if (kind === "paid") {
    const used = await countToday(PAID_TOOLS);
    if (used >= config.mcpDailyPaidCallCap) {
      throw new Error(
        `Daily paid-call cap reached (${used}/${config.mcpDailyPaidCallCap}). Do not retry — ask the operator (Telegram) whether to raise MCP_DAILY_PAID_CALL_CAP or wait until tomorrow.`
      );
    }
  } else if (kind === "scan") {
    const used = await countToday(SCAN_TOOLS);
    if (used >= config.mcpDailyScanCap) {
      throw new Error(
        `Daily scan cap reached (${used}/${config.mcpDailyScanCap}). Do not retry — ask the operator (Telegram).`
      );
    }
  }
}

async function record(entry: {
  tool: string;
  reelId: number | null;
  args: unknown;
  rationale: string | null;
  ok: boolean;
  error: string | null;
}): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO agent_actions (tool, reel_id, args, rationale, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.tool, entry.reelId, JSON.stringify(entry.args ?? null), entry.rationale, entry.ok, entry.error]
    );
  } catch (err) {
    // The audit write failing must not mask the action's own result.
    console.error("[mcp audit] failed to record action:", err instanceof Error ? err.message : String(err));
  }
}

export async function withAudit<T>(
  tool: string,
  kind: ToolKind,
  meta: { reelId?: number | null; args?: unknown; rationale?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  await enforceCap(kind);
  try {
    const result = await fn();
    await record({ tool, reelId: meta.reelId ?? null, args: meta.args, rationale: meta.rationale ?? null, ok: true, error: null });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record({ tool, reelId: meta.reelId ?? null, args: meta.args, rationale: meta.rationale ?? null, ok: false, error: message });
    throw err;
  }
}
