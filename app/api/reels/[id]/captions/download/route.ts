import { NextResponse } from "next/server";
import fs from "node:fs";
import { getReel } from "@/lib/reels";

// Streams the captioned, metadata-stripped final video — the remote-deploy
// equivalent of "Reveal in Finder" (which only works on the local machine).
export async function GET(
  _request: Request,
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
  if (!fs.existsSync(reel.captions_video_path)) {
    return NextResponse.json(
      { error: `Captioned video no longer exists at ${reel.captions_video_path}.` },
      { status: 404 }
    );
  }

  const data = fs.readFileSync(reel.captions_video_path);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="reel_${reel.id}_captioned.mp4"`,
    },
  });
}
