import { NextResponse } from "next/server";
import { hasAppPassword } from "@/lib/config";
import { createSessionToken, verifyPassword, SESSION_COOKIE } from "@/lib/session";

export async function POST(request: Request) {
  if (!hasAppPassword()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not configured on the server." },
      { status: 500 }
    );
  }
  const body = await request.json().catch(() => ({}));
  const password = String(body.password ?? "");
  if (!verifyPassword(password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
