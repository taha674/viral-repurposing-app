import { NextResponse } from "next/server";
import { revealCaptionedVideo } from "@/lib/service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await revealCaptionedVideo(Number(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to open Finder";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
