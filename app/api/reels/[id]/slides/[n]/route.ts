import { NextResponse } from "next/server";
import { getReel } from "@/lib/reels";
import { mimeOf, streamFile } from "@/lib/fileStream";

// One of a carousel's uploaded, metadata-stripped slides (0-based n).
export async function GET(request: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const reel = await getReel(Number(id));
  const file = reel?.slide_paths?.[Number(n)];
  if (!reel || !file) return NextResponse.json({ error: "not found" }, { status: 404 });
  return streamFile(request, file, mimeOf(file), "inline", `${reel.slug ?? reel.id}-slide-${Number(n) + 1}.png`);
}
