import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { saveSourceVideo } from "@/lib/service";
import { withAudit } from "@/lib/mcp/audit";
import { verifyUploadToken } from "@/lib/mcp/uploadToken";

export const maxDuration = 300;

// Public per proxy.ts; self-authenticated by the signed token that
// create_video_upload_link mints. Same effect as the browser's
// POST /api/reels/[id]/video — saves the file, does not burn.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyUploadToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid or expired upload link." }, { status: 404 });
  }
  try {
    const file = (await request.formData()).get("video");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No video file provided (form field "video").' }, { status: 400 });
    }
    if (file.size > config.captionsMaxVideoMb * 1024 * 1024) {
      return NextResponse.json({ error: `Video is over the ${config.captionsMaxVideoMb}MB cap.` }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const reel = await withAudit(
      "upload_video_via_link",
      "write",
      { reelId: verified.reelId, args: { bytes: buffer.length } },
      () => saveSourceVideo(verified.reelId, buffer)
    );
    return NextResponse.json({ ok: true, reel_id: reel.id, next: "call burn_captions" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Video upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
