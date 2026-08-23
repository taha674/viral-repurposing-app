import { NextResponse } from "next/server";
import { getReel } from "@/lib/reels";
import { streamFile } from "@/lib/fileStream";

// Inline audio for the Audio stage's <audio> play button — same file as the
// download route, but Content-Disposition: inline and Range-aware so the
// player can seek.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reel = await getReel(Number(id));
  if (!reel) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (reel.voiceover_status !== "success" || !reel.voiceover_path) {
    return NextResponse.json(
      { error: "No voiceover file yet — generate one first." },
      { status: 400 }
    );
  }
  const name = reel.slug ? `${reel.slug}-audio.mp3` : `reel_${reel.id}_voiceover.mp3`;
  return streamFile(request, reel.voiceover_path, "audio/mpeg", "inline", name);
}
