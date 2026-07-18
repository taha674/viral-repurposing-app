import { NextResponse } from "next/server";
import { revealVoiceover } from "@/lib/service";

// Opens Finder with the generated voiceover file selected (local machine only).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await revealVoiceover(Number(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to open Finder";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
