import { NextResponse } from "next/server";
import { approveEngagement, dropEngagement, markSent } from "@/lib/engagement";

// The operator acting in the web app: approving here is the human gate
// itself, so no quoted reply is needed (that rail is for the agent, in
// lib/mcp/tools.ts). Nothing here sends anything.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const body = await request.json();
  try {
    const e =
      body.action === "approve"
        ? await approveEngagement(id, typeof body.text === "string" ? body.text : null, "approved in the web app")
        : body.action === "drop"
        ? await dropEngagement(id, String(body.reason ?? "dropped in the web app"))
        : body.action === "sent"
        ? await markSent(id)
        : null;
    if (!e) return NextResponse.json({ error: "action must be approve, drop or sent" }, { status: 400 });
    return NextResponse.json({ engagement: e });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
