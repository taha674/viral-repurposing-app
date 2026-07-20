import { NextResponse } from "next/server";
import crypto from "node:crypto";
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
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.cronSecret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
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
