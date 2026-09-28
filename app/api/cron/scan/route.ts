import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/bearer";
import { runScan } from "@/lib/service";
import { config, hasCronSecret } from "@/lib/config";

// Scheduled-scan trigger, hit by a Railway cron service (weekly, Monday
// 6am US Eastern — see tasks.md). Not gated by the browser password/cookie
// (there's no browser here); auth is a bearer secret instead.
export async function POST(request: Request) {
  if (!hasCronSecret()) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server." },
      { status: 500 }
    );
  }
  if (!bearerMatches(request, config.cronSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runScan();
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
