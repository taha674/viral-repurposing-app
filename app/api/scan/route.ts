import { NextResponse } from "next/server";
import { runScan } from "@/lib/service";
import { listScanLogs } from "@/lib/scanLogs";

// Recent scan logs (visible in the app per PRD §5.2).
export async function GET() {
  const logs = await listScanLogs(100);
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
