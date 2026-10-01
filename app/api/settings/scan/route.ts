import { NextResponse } from "next/server";
import {
  SCAN_LIMIT_DEFAULTS,
  SCAN_LIMIT_MAX,
  getScanLimits,
  isScheduledScanEnabled,
  resetScanLimits,
  saveScanLimits,
  setScheduledScanEnabled,
} from "@/lib/scanSettings";

// Backs the Scan panel on the Settings page. Session-gated like the rest of
// /api/* (proxy.ts). The scheduled cron endpoint reads the same settings.

async function snapshot() {
  return {
    scheduledEnabled: await isScheduledScanEnabled(),
    limits: await getScanLimits(),
    defaults: SCAN_LIMIT_DEFAULTS,
    max: SCAN_LIMIT_MAX,
  };
}

export async function GET() {
  return NextResponse.json(await snapshot());
}

// Body: { scheduledEnabled?: boolean, limits?: ScanLimits }
export async function PUT(request: Request) {
  let body: { scheduledEnabled?: unknown; limits?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    body.scheduledEnabled !== undefined &&
    typeof body.scheduledEnabled !== "boolean"
  ) {
    return NextResponse.json({ error: "scheduledEnabled must be a boolean" }, { status: 400 });
  }
  if (body.limits !== undefined) {
    const error = await saveScanLimits(body.limits);
    if (error) return NextResponse.json({ error }, { status: 400 });
  }
  if (typeof body.scheduledEnabled === "boolean") {
    await setScheduledScanEnabled(body.scheduledEnabled);
  }
  return NextResponse.json(await snapshot());
}

export async function DELETE() {
  await resetScanLimits();
  return NextResponse.json(await snapshot());
}
