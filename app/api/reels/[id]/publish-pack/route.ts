import { NextResponse } from "next/server";
import { generatePublishPack } from "@/lib/service";

// Generate (or regenerate) the suggested caption, hashtags and cover text
// hook for this reel. Always a deliberate operator action — the pack is
// written from the CURRENT adapted_script, so re-running after a hand-edit
// is the expected flow, not an exception.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await generatePublishPack(Number(id));
    return NextResponse.json({ reel });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Publish pack generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
