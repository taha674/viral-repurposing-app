import { NextResponse } from "next/server";
import { burnCaptions } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";
import { config } from "@/lib/config";

// Accepts a finished HeyGen/edited video (multipart field "video"), burns
// word-synced subtitles onto it, and strips metadata in the same pass.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const formData = await request.formData();
    const file = formData.get("video");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'No video file provided (form field "video").' },
        { status: 400 }
      );
    }
    const maxBytes = config.captionsMaxVideoMb * 1024 * 1024;
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `Video is over the ${config.captionsMaxVideoMb}MB cap.` },
        { status: 400 }
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const reel = await burnCaptions(Number(id), buffer);
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Caption burn failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
