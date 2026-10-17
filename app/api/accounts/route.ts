import { NextResponse } from "next/server";
import { listAccounts, addAccount } from "@/lib/accounts";
import { parseBrand } from "@/lib/brands";

export async function GET(request: Request) {
  const brand = parseBrand(new URL(request.url).searchParams.get("brand"));
  return NextResponse.json({ accounts: await listAccounts(brand) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const handle = String(body.handle ?? "").trim();
    if (!handle) {
      return NextResponse.json({ error: "handle is required" }, { status: 400 });
    }
    const account = await addAccount(handle, parseBrand(body.brand));
    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
