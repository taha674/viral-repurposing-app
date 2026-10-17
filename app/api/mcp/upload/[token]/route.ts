import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { saveSourceVideo, saveStoryFile, saveSlides } from "@/lib/service";
import { getReel } from "@/lib/reels";
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
    const form = await request.formData();
    const target = await getReel(verified.reelId);
    if (target?.kind === "carousel") {
      // Slides arrive as repeated "slides" fields; their order is kept.
      const files = form.getAll("slides").filter((f): f is File => f instanceof File);
      const reel = await withAudit("upload_slides_via_link", "write", { reelId: verified.reelId, args: { count: files.length } }, async () =>
        saveSlides(verified.reelId, await Promise.all(files.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) }))))
      );
      return NextResponse.json({ ok: true, reel_id: reel.id, slides: reel.slide_paths?.length, next: "generate_publish_pack, then schedule_item" });
    }
    const file = form.get("video");
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
      async () =>
        target?.kind === "story"
          ? saveStoryFile(verified.reelId, buffer, file.name)
          : saveSourceVideo(verified.reelId, buffer)
    );
    return NextResponse.json({
      ok: true,
      reel_id: reel.id,
      next: reel.kind === "story" ? "ask the operator, then approve_item" : "call burn_captions",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Video upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
