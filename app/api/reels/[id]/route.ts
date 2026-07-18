import { NextResponse } from "next/server";
import { getReel, updateEditable, setStatus, parseAnalysis } from "@/lib/reels";
import type { ReelStatus } from "@/lib/types";

const ALLOWED_STATUSES: ReelStatus[] = [
  "new",
  "transcribed",
  "adapted",
  "approved",
  "archived",
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reel = getReel(Number(id));
  if (!reel) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
}

// Inline edits (transcript / adapted_script) and status transitions (approve/archive).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reelId = Number(id);
  if (!getReel(reelId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await request.json();

  if (body.transcript !== undefined || body.adapted_script !== undefined) {
    updateEditable(reelId, {
      transcript: body.transcript,
      adapted_script: body.adapted_script,
    });
  }

  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    setStatus(reelId, body.status);
  }

  return NextResponse.json({ reel: getReel(reelId) });
}
