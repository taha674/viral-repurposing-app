import { NextResponse } from "next/server";
import { listReelSummaries } from "@/lib/reels";
import { addManualReel } from "@/lib/service";

// Board payload: every reel, trimmed (see listReelSummaries — no transcript,
// analysis, or voiceover_alignment). The board groups these into columns via
// lib/stages.ts#stageOf client-side, so there's no server-side status filter
// here any more.
export async function GET() {
  return NextResponse.json({ reels: await listReelSummaries() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const url = String(body.url ?? "").trim();
    const force = Boolean(body.force);
    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }
    if (!/instagram\.com\//i.test(url)) {
      return NextResponse.json(
        { error: "Only Instagram URLs are supported in the MVP." },
        { status: 400 }
      );
    }
    const result = await addManualReel(url, force);
    if (!result.qualifies && !result.forced) {
      return NextResponse.json(
        {
          qualifies: false,
          views: result.reel.views,
          message:
            "Below the 1M-view threshold. Re-submit with force=true to track it anyway.",
        },
        { status: 200 }
      );
    }
    return NextResponse.json({ reel: result.reel, forced: result.forced }, {
      status: 201,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add reel";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
