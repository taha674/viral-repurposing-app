import { NextResponse } from "next/server";
import { listHashtags, addHashtag } from "@/lib/hashtags";

export async function GET() {
  return NextResponse.json({ hashtags: await listHashtags() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const tag = String(body.tag ?? "").trim();
    if (!tag) {
      return NextResponse.json({ error: "tag is required" }, { status: 400 });
    }
    const hashtag = await addHashtag(tag);
    return NextResponse.json({ hashtag }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add hashtag";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
