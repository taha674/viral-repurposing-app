import crypto from "node:crypto";
import { config } from "../config";

// Short-lived signed links to a reel's finished files, served by
// /api/mcp/media/[token]. Keyed off MCP_API_TOKEN (domain-separated from the
// upload tokens), so the MCP needs only that secret plus PUBLIC_BASE_URL —
// nothing from the Instagram bot's config.
const TTL_MS = 10 * 60 * 1000;
export type McpMediaKind = "audio" | "video";

function mac(payload: string): string {
  return crypto.createHmac("sha256", config.mcpApiToken).update(`media:${payload}`).digest("hex");
}

function signMediaToken(reelId: number, kind: McpMediaKind): string {
  const payload = `${reelId}.${kind}.${Date.now() + TTL_MS}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac(payload)}`;
}

export function verifyMcpMediaToken(token: string): { reelId: number; kind: McpMediaKind } | null {
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
  const [reelIdStr, kind, expStr] = payload.split(".");
  const reelId = Number(reelIdStr);
  if (!Number.isInteger(reelId) || !Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null;
  if (kind !== "audio" && kind !== "video") return null;
  return { reelId, kind };
}

export function mcpMediaUrl(reelId: number, kind: McpMediaKind): string {
  if (!config.publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is not set — cannot build a media link.");
  }
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/mcp/media/${signMediaToken(reelId, kind)}`;
}
