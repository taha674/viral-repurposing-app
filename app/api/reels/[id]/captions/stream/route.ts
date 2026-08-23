import { NextResponse } from "next/server";
import { getReel } from "@/lib/reels";
import { streamFile } from "@/lib/fileStream";

// Inline video for the Subtitled stage's <video> player — same file as the
// download route, but Content-Disposition: inline and Range-aware so the
// player can seek without downloading the whole file first.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reel = await getReel(Number(id));
  if (!reel) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (reel.captions_status !== "success" || !reel.captions_video_path) {
    return NextResponse.json(
      { error: "No captioned video yet — burn captions first." },
      { status: 400 }
    );
  }
  const name = reel.slug ? `${reel.slug}-subtitled.mp4` : `reel_${reel.id}_captioned.mp4`;
  return streamFile(request, reel.captions_video_path, "video/mp4", "inline", name);
}
