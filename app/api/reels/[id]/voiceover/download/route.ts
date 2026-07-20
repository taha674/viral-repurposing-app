import { NextResponse } from "next/server";
import fs from "node:fs";
import { getReel } from "@/lib/reels";

// Streams the generated voiceover .mp3 for download — the remote-deploy
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
  if (reel.voiceover_status !== "success" || !reel.voiceover_path) {
    return NextResponse.json(
      { error: "No voiceover file to download yet — generate one first." },
      { status: 400 }
    );
  }
  if (!fs.existsSync(reel.voiceover_path)) {
    return NextResponse.json(
      { error: `Voiceover file no longer exists at ${reel.voiceover_path}.` },
      { status: 404 }
    );
  }

  const data = fs.readFileSync(reel.voiceover_path);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `attachment; filename="reel_${reel.id}_voiceover.mp3"`,
    },
  });
}
