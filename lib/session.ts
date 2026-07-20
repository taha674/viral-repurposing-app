import crypto from "node:crypto";
import { config } from "./config";

// Stateless session cookie for the single shared-password gate. No user
// accounts — just "did this browser prove it knows APP_PASSWORD, recently."
// The signing key is derived from APP_PASSWORD so no separate secret is
// needed; rotating the password also invalidates existing sessions.

export const SESSION_COOKIE = "app_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signingKey(): Buffer {
  return crypto.createHash("sha256").update(config.appPassword).digest();
}

function sign(expiresAt: number): string {
  const hmac = crypto
    .createHmac("sha256", signingKey())
    .update(String(expiresAt))
    .digest("hex");
  return `${expiresAt}.${hmac}`;
}

export function createSessionToken(): string {
  return sign(Date.now() + SESSION_TTL_MS);
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [expiresAtRaw, hmac] = token.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!expiresAt || !hmac || Number.isNaN(expiresAt)) return false;
  if (Date.now() > expiresAt) return false;

  const expected = crypto
    .createHmac("sha256", signingKey())
    .update(String(expiresAt))
    .digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyPassword(candidate: string): boolean {
  const expected = Buffer.from(config.appPassword);
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
