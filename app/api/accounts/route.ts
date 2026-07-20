import { NextResponse } from "next/server";
import { listAccounts, addAccount } from "@/lib/accounts";

export async function GET() {
  return NextResponse.json({ accounts: await listAccounts() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const handle = String(body.handle ?? "").trim();
    if (!handle) {
      return NextResponse.json({ error: "handle is required" }, { status: 400 });
    }
    const account = await addAccount(handle);
    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
