import { NextResponse } from "next/server";
import { getReel } from "@/lib/reels";
import { streamFile } from "@/lib/fileStream";
import { verifyMcpMediaToken } from "@/lib/mcp/mediaToken";

// Public per proxy.ts; self-authenticated by the signed token get_media_links
// mints. Serves only reel.captions_video_path (the metadata-stripped burn
// output) for "video" — never source_video_path — so the mandatory-strip
// guarantee holds for every file this route can return.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyMcpMediaToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 });
  }
  const reel = await getReel(verified.reelId);
  if (!reel) return NextResponse.json({ error: "Reel not found." }, { status: 404 });

  if (verified.kind === "video") {
    if (reel.captions_status !== "success" || !reel.captions_video_path) {
      return NextResponse.json({ error: "No finished video for this reel yet." }, { status: 404 });
    }
    return streamFile(request, reel.captions_video_path, "video/mp4", "inline", `reel-${reel.id}.mp4`);
  }
  if (reel.voiceover_status !== "success" || !reel.voiceover_path) {
    return NextResponse.json({ error: "No voiceover for this reel yet." }, { status: 404 });
  }
  return streamFile(request, reel.voiceover_path, "audio/mpeg", "inline", `reel-${reel.id}-voiceover.mp3`);
}
