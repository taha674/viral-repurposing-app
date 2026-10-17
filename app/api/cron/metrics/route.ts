import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/bearer";
import { config, hasCronSecret } from "@/lib/config";
import { refreshPostedMetrics } from "@/lib/metrics";

// Weekly metrics read (ticket 09), hit by .github/workflows/weekly-metrics.yml
// the same way the scan cron is: bearer CRON_SECRET, no browser session.
// Paid (treg, ~$0.0015 per posted Instagram link), inside the treg daily cap.
export async function POST(request: Request) {
  if (!hasCronSecret()) {
    return NextResponse.json({ error: "CRON_SECRET is not configured on the server." }, { status: 500 });
  }
  if (!bearerMatches(request, config.cronSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await refreshPostedMetrics());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Metrics read failed" }, { status: 500 });
  }
}
