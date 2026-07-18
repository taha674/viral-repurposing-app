import { NextResponse } from "next/server";
import { adaptReel } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";

// Run the red-line-compliance adaptation (minimal edits, no voice rewrite).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await adaptReel(Number(id));
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Adaptation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
