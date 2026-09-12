import { NextResponse } from "next/server";
import {
  getReel,
  updateEditable,
  setStatus,
  advanceStatus,
  parseAnalysis,
} from "@/lib/reels";
import { archiveReel } from "@/lib/service";
import type { ReelStatus } from "@/lib/types";

// The status transitions this generic PATCH accepts from the client.
// "captioned" is still never client-settable — it's only ever the *result*
// of a specific action (the subtitle burn) via its own endpoint.
//
// "approved" and "rejected" are the two genuine human-resolves-the-red-line
// moments (adaptation -> approved, any stage -> rejected) and go through
// setStatus, which clears red_line_flag/reason. Everything else here is a
// plain board move — forward ("video" for audio -> video) or the "Move
// back"/reject-undo path back to an earlier column ("new"/"transcribed",
// "accepted", "adapted", "approved", "video") — and goes through
// advanceStatus, which leaves the flag untouched.
const CLIENT_SETTABLE_STATUSES: ReelStatus[] = [
  "new",
  "transcribed",
  "accepted",
  "adapted",
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

  if (
    body.transcript !== undefined ||
    body.adapted_script !== undefined ||
    body.publish_pack !== undefined
  ) {
    await updateEditable(reelId, {
      transcript: body.transcript,
      adapted_script: body.adapted_script,
      // The operator's edited caption / pruned tag list, saved back as one
      // blob. Generation has its own endpoint (POST .../publish-pack); this
      // is only the hand-edit path.
      publish_pack: body.publish_pack,
    });
  }

  if (body.status !== undefined) {
    if (!CLIENT_SETTABLE_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    if (body.status === "archived") {
      // Archive is not a plain board move — it deletes the reel's files
      // from the volume, so it goes through the service layer rather than
      // a bare status write. See service.ts#archiveReel.
      await archiveReel(reelId);
    } else if (FLAG_RESOLVING_STATUSES.includes(body.status)) {
      await setStatus(reelId, body.status);
    } else {
      await advanceStatus(reelId, body.status);
    }
  }

  return NextResponse.json({ reel: await getReel(reelId) });
}
