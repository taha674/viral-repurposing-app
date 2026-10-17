import { NextResponse } from "next/server";
import { listHashtags, addHashtag } from "@/lib/hashtags";
import { parseBrand } from "@/lib/brands";

export async function GET(request: Request) {
  const brand = parseBrand(new URL(request.url).searchParams.get("brand"));
  return NextResponse.json({ hashtags: await listHashtags(brand) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const tag = String(body.tag ?? "").trim();
    if (!tag) {
      return NextResponse.json({ error: "tag is required" }, { status: 400 });
    }
    const kind = body.kind === "keyword" ? "keyword" : "hashtag";
    const hashtag = await addHashtag(tag, parseBrand(body.brand), kind);
    return NextResponse.json({ hashtag }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add hashtag";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
