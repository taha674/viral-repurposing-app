import { NextResponse } from "next/server";
import { getReel } from "@/lib/reels";
import { mimeOf, streamFile } from "@/lib/fileStream";

// Streams the captioned, metadata-stripped final video — the remote-deploy
// equivalent of "Reveal in Finder" (which only works on the local machine).
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
      { error: "No captioned video to download yet — burn captions first." },
      { status: 400 }
    );
  }
  const name = reel.slug ? `${reel.slug}-subtitled.mp4` : `reel_${reel.id}_captioned.mp4`;
  return streamFile(request, reel.captions_video_path, mimeOf(reel.captions_video_path), "attachment", name);
}
