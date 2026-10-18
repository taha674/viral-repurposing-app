import { config } from "./config";
import { getReel } from "./reels";
import { markPosted } from "./service";
import { tregCall } from "./treg";
import { mcpMediaUrl } from "./mcp/mediaToken";
import type { Reel } from "./types";

// Publishing a Nuronomics post to Instagram (ticket 16). Root CLAUDE.md,
// "Instagram publishing for Nuronomics through the official API": Nuronomics
// only, a scheduled item only, at or after its planned time, after the
// operator's quoted approval (checked in lib/mcp/tools.ts), within
// INSTAGRAM_DAILY_PUBLISH_CAP. Every Graph call goes through treg to the
// team's own registered tool for the hifz account. The AI-content label is
// never set (the Graph calls below never pass it); an item that needs it is
// posted by hand. Nothing else in the app posts anywhere.
//
// Flow: create the media container(s) with the app's signed media links as
// the public URLs -> poll the container to FINISHED (hard cap) -> publish
// (never retried: a repeat could post twice) -> read the permalink ->
// record it through the mark_posted path. Any failure throws before the
// item changes, so it stays scheduled for the operator to post by hand.

type Row = Record<string, unknown>;

async function graph(method: "GET" | "POST", path: string, params: Record<string, string>, retries?: number): Promise<Row> {
  const endpoint = `${config.instagramPublishTool}/${config.instagramApiVersion}/${path}`;
  const res =
    method === "POST"
      ? await tregCall(endpoint, { body: params, retries })
      : await tregCall(endpoint, { query: params, retries });
  const err = res.error as Row | undefined;
  if (err) throw new Error(`Instagram: ${String(err.message ?? JSON.stringify(err))}`);
  return res;
}

const user = () => config.instagramPublishUserId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFinished(containerId: string): Promise<void> {
  for (let i = 0; i < config.instagramPublishPollMax; i++) {
    const s = await graph("GET", containerId, { fields: "status_code,status" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new Error(`Instagram rejected the media (${s.status_code}): ${String(s.status ?? "no detail")}`);
    }
    await sleep(config.instagramPublishPollMs);
  }
  throw new Error(`Instagram was still processing after ${config.instagramPublishPollMax} checks; nothing was published.`);
}

// Caption as approved: the publish pack's caption, then its hashtags.
function captionOf(reel: Reel): string {
  const pack = reel.publish_pack!;
  const tags = pack.hashtags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  return tags ? `${pack.caption}\n\n${tags}` : pack.caption;
}

const isImage = (p: string | null) => /\.(png|jpe?g|webp)$/i.test(p ?? "");

// Checks the item may be published, then publishes it. Returns the reel,
// now posted with its Instagram permalink.
export async function publishToInstagram(reelId: number): Promise<Reel> {
  const reel = await getReel(reelId);
  if (!reel) throw new Error(`Reel ${reelId} not found`);
  if (reel.brand !== "nuronomics") throw new Error("Only Nuronomics posts are published by the app; Cyrus posts stay manual.");
  if (reel.status !== "scheduled") throw new Error(`Item ${reelId} is "${reel.status}", not scheduled.`);
  if (!["reel", "carousel", "story"].includes(reel.kind)) throw new Error(`A ${reel.kind} is not published to Instagram.`);
  if (reel.planned_post_at && Date.now() < new Date(reel.planned_post_at).getTime()) {
    throw new Error(`Item ${reelId} is planned for ${reel.planned_post_at}; publish it at or after that time.`);
  }
  if (reel.kind !== "story" && !reel.publish_pack?.caption?.trim()) {
    throw new Error("No approved caption (publish pack) on this item.");
  }
  if (reel.kind === "carousel" ? !reel.slide_paths?.length : reel.captions_status !== "success" || !reel.captions_video_path) {
    throw new Error("The item's finished, metadata-stripped file is missing.");
  }

  let containerId: string;
  if (reel.kind === "reel") {
    const pack = reel.publish_pack!;
    const params: Record<string, string> = {
      media_type: "REELS",
      video_url: mcpMediaUrl(reel.id, "video"),
      caption: captionOf(reel),
      share_to_feed: "true",
    };
    if (pack.cover_frame_seconds != null) params.thumb_offset = String(Math.round(pack.cover_frame_seconds * 1000));
    containerId = String((await graph("POST", `${user()}/media`, params)).id);
  } else if (reel.kind === "carousel") {
    const children: string[] = [];
    for (let i = 0; i < reel.slide_paths!.length; i++) {
      const child = await graph("POST", `${user()}/media`, { image_url: mcpMediaUrl(reel.id, `slide${i}`), is_carousel_item: "true" });
      children.push(String(child.id));
    }
    containerId = String(
      (await graph("POST", `${user()}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: captionOf(reel) })).id
    );
  } else {
    const url = mcpMediaUrl(reel.id, "video");
    containerId = String(
      (await graph("POST", `${user()}/media`, { media_type: "STORIES", ...(isImage(reel.captions_video_path) ? { image_url: url } : { video_url: url }) })).id
    );
  }
  if (!containerId || containerId === "undefined") throw new Error("Instagram returned no container id.");

  await waitFinished(containerId);
  const published = await graph("POST", `${user()}/media_publish`, { creation_id: containerId }, 0);
  const mediaId = String(published.id ?? "");
  if (!mediaId) throw new Error("Instagram returned no media id after publishing.");

  // From here the post is live: a failure reading the link must not be
  // mistaken for a failed publish.
  let permalink: string;
  try {
    permalink = String((await graph("GET", mediaId, { fields: "permalink" })).permalink ?? "");
    if (!permalink.startsWith("https://")) throw new Error("no permalink");
  } catch (err) {
    throw new Error(
      `PUBLISHED (Instagram media ${mediaId}) but the link could not be read: ${err instanceof Error ? err.message : String(err)}. Do not publish again; ask the operator for the link and use mark_posted.`
    );
  }
  return markPosted(reel.id, [{ platform: "instagram", url: permalink }]);
}
