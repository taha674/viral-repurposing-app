import { NextResponse } from "next/server";
import { outputDirSizeBytes, formatBytes } from "@/lib/retention";
import { autoPurgeIfOverThreshold } from "@/lib/service";
import { config } from "@/lib/config";

// Backs the Storage panel on the Settings page. Session-gated like the rest
// of the app (proxy.ts covers every /api/* path except /api/login and
// /api/cron) — this is an operator control, not an external cron trigger,
// so it doesn't need CRON_SECRET's bearer-token auth.

export async function GET() {
  const bytes = outputDirSizeBytes();
  const thresholdBytes = config.volumePurgeThresholdMb * 1024 * 1024;
  return NextResponse.json({
    bytes,
    formatted: formatBytes(bytes),
    thresholdBytes,
    thresholdMb: config.volumePurgeThresholdMb,
    overThreshold: bytes > thresholdBytes,
  });
}

// Runs the same threshold check the app makes automatically before every
// voiceover/upload/burn — this just lets the operator trigger it on demand
// (e.g. right after archiving a batch of reels) instead of waiting for the
// next write. It is NOT a "wipe now" button: below the threshold, it is a
// no-op and reports so.
export async function POST() {
  try {
    const result = await autoPurgeIfOverThreshold();
    return NextResponse.json({
      result,
      bytes: result.afterBytes,
      formatted: formatBytes(result.afterBytes),
      freedFormatted: formatBytes(result.freedBytes),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Purge check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
