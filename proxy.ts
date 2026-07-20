import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasAppPassword } from "@/lib/config";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/session";

// Single shared-password gate (Railway deploy only). If APP_PASSWORD isn't
// set — the local-dev default — the gate is a no-op, matching the decision
// in open-questions.md #10 ("no auth locally").
// /api/cron/* authenticates itself via a bearer secret (CRON_SECRET) —
// it has no browser session to check a cookie against.
const PUBLIC_PATHS = ["/login", "/api/login", "/api/cron"];

export function proxy(req: NextRequest) {
  if (!hasAppPassword()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
