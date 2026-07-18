import { NextResponse } from "next/server";
import { generateVoiceover } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";

// Generate the ElevenLabs voiceover for an approved, adapted script.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await generateVoiceover(Number(id));
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Voiceover generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
