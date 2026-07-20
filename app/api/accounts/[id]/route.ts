import { NextResponse } from "next/server";
import { setAccountActive, removeAccount } from "@/lib/accounts";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active (boolean) required" }, { status: 400 });
  }
  await setAccountActive(Number(id), body.active);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await removeAccount(Number(id));
  return NextResponse.json({ ok: true });
}
