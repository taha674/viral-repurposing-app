import { NextResponse } from "next/server";
import { acceptReel } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";

// Scraped -> Script column. Mints the reel's slug (lib/naming.ts) — see
// acceptReel in lib/service.ts.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await acceptReel(Number(id));
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to accept reel";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
