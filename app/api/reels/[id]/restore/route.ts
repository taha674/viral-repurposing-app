import { NextResponse } from "next/server";
import { restoreReel } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";

// Rejected/Done tray -> back onto the board. Target column is inferred
// server-side from which tray the reel is in — see restoreReel in
// lib/service.ts.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await restoreReel(Number(id));
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to restore reel";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
