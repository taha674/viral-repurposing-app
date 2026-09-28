import crypto from "node:crypto";

// Timing-safe "Authorization: Bearer <secret>" check, shared by the cron
// route (CRON_SECRET) and the MCP route (MCP_API_TOKEN).
export function bearerMatches(request: Request, secret: string): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
