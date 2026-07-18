import { NextResponse } from "next/server";
import { retrieveTranscript } from "@/lib/service";

// Retry transcript retrieval for a reel (hard-capped by the Apify client).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const reel = await retrieveTranscript(Number(id));
    return NextResponse.json({ reel });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Transcript retrieval failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
