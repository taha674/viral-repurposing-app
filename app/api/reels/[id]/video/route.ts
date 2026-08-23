import { NextResponse } from "next/server";
import { saveSourceVideo } from "@/lib/service";
import { parseAnalysis } from "@/lib/reels";
import { config } from "@/lib/config";

// Accepts the finished HeyGen/edited video (multipart field "video") once
// the reel has been sent to the Video stage. Uploading alone does not
// advance the status further — burning subtitles (POST .../captions) is the
// separate, explicit next step.
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
    const reel = await saveSourceVideo(Number(id), buffer);
    return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Video upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
