import crypto from "node:crypto";
import { config } from "../config";

// Short-lived signed token for /api/mcp/upload/[token] — lets the agent
// `curl -F video=@file` a finished render straight into one reel without the
// bearer token ever leaving the MCP channel. Keyed off MCP_API_TOKEN, so
// rotating it invalidates outstanding links. Same shape as signMediaToken in
// lib/instagram.ts, scoped to one reel + expiry.
const TTL_MS = 15 * 60 * 1000;

function mac(payload: string): string {
  return crypto.createHmac("sha256", config.mcpApiToken).update(`upload:${payload}`).digest("hex");
}

export function signUploadToken(reelId: number): string {
  const payload = `${reelId}.${Date.now() + TTL_MS}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac(payload)}`;
}

export function verifyUploadToken(token: string): { reelId: number } | null {
  if (!config.mcpApiToken) return null;
  const sep = token.indexOf(".");
  if (sep < 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, sep), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const a = Buffer.from(mac(payload));
  const b = Buffer.from(token.slice(sep + 1));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [reelIdStr, expStr] = payload.split(".");
  const reelId = Number(reelIdStr);
  if (!Number.isInteger(reelId) || !Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null;
  return { reelId };
}

export function uploadUrl(reelId: number): string {
  if (!config.publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is not set — cannot build an upload link.");
  }
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/upload/${signUploadToken(reelId)}`;
}
