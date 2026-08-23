import { NextResponse } from "next/server";
import {
  getReel,
  updateEditable,
  setStatus,
  advanceStatus,
  parseAnalysis,
} from "@/lib/reels";
import type { ReelStatus } from "@/lib/types";

// The only status transitions this generic PATCH accepts from the client —
// every other status ("new", "transcribed", "accepted", "adapted",
// "captioned") is set server-side as the *result* of a specific action
// (transcript pull, accept, adaptation, burn) via its own endpoint, not by
// the client asserting an arbitrary status here.
//
// "approved" and "rejected" are the two genuine human-resolves-the-red-line
// moments (adaptation -> approved, scraped -> rejected) and go through
// setStatus, which clears red_line_flag/reason. "video" (audio -> video,
// once the voiceover is ready) and "archived" (subtitled -> archived) are
// plain board moves and go through advanceStatus, which does not.
const CLIENT_SETTABLE_STATUSES: ReelStatus[] = [
  "approved",
  "rejected",
  "video",
  "archived",
];
const FLAG_RESOLVING_STATUSES: ReelStatus[] = ["approved", "rejected"];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reel = await getReel(Number(id));
  if (!reel) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ reel, analysis: parseAnalysis(reel) });
}

// Inline edits (transcript / adapted_script) and the client-triggerable
// status transitions — see CLIENT_SETTABLE_STATUSES above. Accept and
// Restore go through their own endpoints instead (server-side logic beyond
// a plain status set: slug minting, tray-target inference).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reelId = Number(id);
  if (!(await getReel(reelId))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await request.json();

  if (body.transcript !== undefined || body.adapted_script !== undefined) {
    await updateEditable(reelId, {
      transcript: body.transcript,
      adapted_script: body.adapted_script,
    });
  }

  if (body.status !== undefined) {
    if (!CLIENT_SETTABLE_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    if (FLAG_RESOLVING_STATUSES.includes(body.status)) {
      await setStatus(reelId, body.status);
    } else {
      await advanceStatus(reelId, body.status);
    }
  }

  return NextResponse.json({ reel: await getReel(reelId) });
}
