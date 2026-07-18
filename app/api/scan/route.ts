import { NextResponse } from "next/server";
import { runScan } from "@/lib/service";
import { getDb } from "@/lib/db";
import type { ScanLog } from "@/lib/types";

// Recent scan logs (visible in the app per PRD §5.2).
export async function GET() {
  const logs = getDb()
    .prepare("SELECT * FROM scan_logs ORDER BY run_at DESC LIMIT 100")
    .all() as ScanLog[];
  return NextResponse.json({ logs });
}

// "Run scan now" — scheduled cron is deferred to the Railway port.
export async function POST() {
  try {
    const summary = await runScan();
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
