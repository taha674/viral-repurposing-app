import { NextResponse } from "next/server";
import { burnCaptions } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";

// Burns word-synced subtitles onto the already-uploaded video (POST
// .../video) and strips metadata in the same pass. No request body — the
// upload and the burn are separate steps now (2026-08-23 kanban revamp).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await burnCaptions(Number(id));
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Caption burn failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
