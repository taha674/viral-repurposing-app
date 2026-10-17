import { NextResponse } from "next/server";
import { listEngagement } from "@/lib/engagement";
import { parseBrand } from "@/lib/brands";

export async function GET(request: Request) {
  const brand = parseBrand(new URL(request.url).searchParams.get("brand"));
  return NextResponse.json({ engagement: await listEngagement({ brand }) });
}
