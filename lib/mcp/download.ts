import net from "node:net";
import { config } from "../config";

const DOWNLOAD_TIMEOUT_MS = 120_000;

// The server fetches a URL the agent supplies, so refuse anything that could
// reach the deploy's own network: https only, no localhost/.internal names,
// no private/loopback/link-local IP literals. (DNS that resolves to a private
// address is not caught here — the bearer token is the real trust boundary;
// this just stops the obvious mistakes.)
function assertPublicHttps(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("That host is not allowed.");
  }
  if (net.isIP(host)) {
    const priv =
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === "::1" ||
      /^(fc|fd|fe80)/.test(host);
    if (priv) throw new Error("That address is not allowed.");
  }
  return url;
}

// One-shot fetch with a timeout and the same CAPTIONS_MAX_VIDEO_MB size cap
// the browser upload route enforces. No retries.
export async function downloadVideo(rawUrl: string): Promise<Buffer> {
  const url = assertPublicHttps(rawUrl);
  const maxBytes = config.captionsMaxVideoMb * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`Video is over the ${config.captionsMaxVideoMb}MB cap.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Video is over the ${config.captionsMaxVideoMb}MB cap.`);
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}
