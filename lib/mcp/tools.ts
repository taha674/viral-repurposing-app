import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config";
import {
  getReel,
  listReelSummaries,
  parseAnalysis,
  setStatus,
  advanceStatus,
  updateEditable,
  setHook,
  listScheduled,
} from "../reels";
import {
  acceptReel,
  addManualReel,
  addOriginal,
  addStory,
  addCarousel,
  addTextPost,
  approveItem,
  scheduleItem,
  unscheduleItem,
  markPosted,
  adaptReel,
  archiveReel,
  burnCaptions,
  generatePublishPack,
  generateVoiceover,
  restoreReel,
  retrieveTranscript,
  runScan,
  saveSourceVideo,
} from "../service";
import { listAccounts, addAccount, setAccountActive, removeAccount } from "../accounts";
import { listHashtags, addHashtag, setHashtagActive, removeHashtag } from "../hashtags";
import { listScanLogs } from "../scanLogs";
import { STAGES, stageOf, backTargetStatus } from "../stages";
import type { Stage } from "../stages";
import { mcpMediaUrl } from "./mediaToken";
import { HOOKS, POST_PLATFORMS, TEXT_CHANNELS, type Brand, type Hook, type Reel, type PublishPack } from "../types";
import { withAudit } from "./audit";
import { downloadVideo } from "./download";
import { uploadUrl } from "./uploadToken";
import { BRANDS, parseBrand } from "../brands";
import { hookSummary, listMetrics, recordMetrics } from "../metrics";
import {
  ENGAGEMENT_KINDS,
  ENGAGEMENT_PLATFORMS,
  approveEngagement,
  draftEngagement,
  dropEngagement,
  listEngagement,
  markSent,
  type EngagementPlatform,
  type EngagementKind,
  type EngagementStatus,
} from "../engagement";

// --- helpers -------------------------------------------------------------

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

// Wraps a handler so a thrown service error becomes an isError result (the
// service's messages are already operator-readable) instead of a protocol
// error.
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const reelId = z.number().int().positive().describe("Reel id");
const hookArg = z
  .enum(HOOKS as [string, ...string[]])
  .describe("Launch hook under test: A forgetting your Manzil, B weak pages, C the adaptive method");
const brandArg = z
  .enum(BRANDS.map((b) => b.id) as [Brand, ...Brand[]])
  .optional()
  .describe("Brand: " + BRANDS.map((b) => b.id).join(" | "));

async function mustGet(id: number): Promise<Reel> {
  const reel = await getReel(id);
  if (!reel) throw new Error(`Reel ${id} not found`);
  return reel;
}

// The next legal moves for a reel, from the same preconditions the service
// functions enforce — so the agent doesn't have to learn them by failing.
function allowedActions(reel: Reel): string[] {
  const a: string[] = [];
  switch (reel.status) {
    case "new":
    case "transcribed":
      a.push("accept_reel", "reject_reel", "edit_reel");
      if (reel.transcript_status !== "success") a.push("retry_transcript");
      break;
    case "accepted":
      if (reel.transcript?.trim()) a.push("adapt_reel");
      a.push("edit_reel", "reject_reel", "move_back");
      break;
    case "adapted":
      a.push("approve_script", "adapt_reel", "edit_reel", "generate_publish_pack", "reject_reel", "move_back");
      break;
    case "approved":
      if (reel.voiceless) {
        a.push("send_to_video", "edit_reel", "reject_reel", "move_back");
        break;
      }
      a.push(reel.voiceover_status === "success" ? "send_to_video" : "generate_voiceover", "edit_reel", "reject_reel", "move_back");
      if (reel.voiceover_status === "success") a.push("generate_voiceover");
      break;
    case "video":
      if (!reel.source_video_path) a.push("upload_video_from_url", "create_video_upload_link");
      else a.push("burn_captions");
      a.push("reject_reel", "move_back");
      break;
    case "captioned":
      a.push("get_media_links", "generate_publish_pack", "edit_reel", "schedule_item", "mark_posted", "reject_reel", "move_back", "archive_reel");
      break;
    case "scheduled":
      a.push("get_media_links", "edit_reel", "schedule_item", "unschedule_item", "mark_posted", "move_back");
      break;
    case "posted":
      a.push("get_media_links", "mark_posted", "move_back", "archive_reel");
      break;
    case "slides":
      a.push("create_slides_upload_link", "edit_reel", "reject_reel", "move_back");
      break;
    case "pending_approval":
      a.push("approve_item", "edit_reel", "reject_reel");
      if (reel.kind === "story") a.push("create_video_upload_link");
      break;
    case "rejected":
    case "archived":
      a.push("restore_reel");
      break;
  }
  return a;
}

// get_reel's payload: full row minus voiceover_alignment (one entry per
// character — huge and useless to an agent), plus stage and allowed_actions.
function presentReel(reel: Reel) {
  const { voiceover_alignment, ...rest } = reel;
  return {
    ...rest,
    has_voiceover_alignment: voiceover_alignment !== null,
    stage: stageOf(reel),
    analysis: parseAnalysis(reel),
    allowed_actions: allowedActions(reel),
  };
}

// What Hermes hands the operator for one ready post. A missing publish pack
// is reported, not invented.
function readyPost(reel: Reel) {
  const pack = reel.publish_pack;
  if (reel.kind === "text") {
    return {
      id: reel.id, brand: reel.brand, kind: reel.kind, hook: reel.hook, slug: reel.slug,
      planned_post_at: reel.planned_post_at, channel: reel.text_channel, body: reel.adapted_script, missing: [],
    };
  }
  return {
    id: reel.id,
    brand: reel.brand,
    kind: reel.kind,
    // A story's description of what it shows.
    ...(reel.kind === "story" ? { text: reel.transcript } : {}),
    hook: reel.hook,
    slug: reel.slug,
    planned_post_at: reel.planned_post_at,
    files: {
      video_url:
        reel.kind !== "carousel" && reel.captions_status === "success" && reel.captions_video_path ? mcpMediaUrl(reel.id, "video") : null,
      ...(reel.kind === "carousel" ? { slide_urls: (reel.slide_paths ?? []).map((_, i) => mcpMediaUrl(reel.id, `slide${i}`)) } : {}),
      expires_in_minutes: 10,
    },
    caption: pack?.caption ?? null,
    hashtags: pack?.hashtags ?? [],
    cover_text: pack?.thumbnail_text.map((t) => t.text) ?? [],
    cover_frame_seconds: pack?.cover_frame_seconds ?? null,
    hook_mode: pack?.hook_mode ?? null,
    // Stories carry no publish pack.
    missing: pack || reel.kind === "story" ? [] : ["publish_pack"],
  };
}

const excerpt = (s: string | null, n = 240) => (s && s.length > n ? s.slice(0, n) + "…" : s);

// --- registration --------------------------------------------------------

export function registerTools(server: McpServer): void {
  // ---- Read (free) ----
  server.registerTool(
    "get_pipeline_overview",
    {
      description:
        "Start here. Counts of reels per kanban stage, plus the reels currently waiting on a decision or action (awaiting accept, awaiting approval, awaiting video upload, ready to burn) and any with a red-line flag. Omit brand for all brands.",
      inputSchema: { brand: brandArg },
    },
    safe(async ({ brand }) => {
      const reels = await listReelSummaries(brand);
      const counts: Record<string, number> = {};
      const brief = (r: (typeof reels)[number]) => ({
        id: r.id,
        brand: r.brand,
        status: r.status,
        red_line_flag: r.red_line_flag,
        views: r.views,
        slug: r.slug,
        hook: r.hook,
        planned_post_at: r.planned_post_at,
      });
      for (const r of reels) counts[stageOf(r)] = (counts[stageOf(r)] ?? 0) + 1;
      return {
        counts_by_stage: counts,
        stages: STAGES.map((s) => s.id),
        awaiting_accept: reels.filter((r) => r.status === "new" || r.status === "transcribed").map(brief),
        awaiting_approval: reels.filter((r) => r.status === "adapted").map(brief),
        awaiting_voiceover: reels.filter((r) => r.status === "approved" && r.voiceover_status !== "success").map(brief),
        awaiting_video_upload: reels.filter((r) => r.status === "video" && !r.source_video_path).map(brief),
        ready_to_burn: reels.filter((r) => r.status === "video" && r.source_video_path).map(brief),
        ready_to_schedule: reels.filter((r) => r.status === "captioned").map(brief),
        scheduled: reels.filter((r) => r.status === "scheduled").map(brief),
        flagged: reels.filter((r) => r.red_line_flag !== "none").map(brief),
      };
    })
  );

  server.registerTool(
    "list_reels",
    {
      description:
        "List reels (trimmed: no transcript/analysis). Optionally filter by kanban stage. Rejected and archived reels are omitted unless include_trays is true. Use get_reel for the full row.",
      inputSchema: {
        stage: z.enum(["scraped", "script", "adaptation", "audio", "video", "subtitled", "scheduled", "posted", "rejected", "done"]).optional(),
        include_trays: z.boolean().optional(),
        brand: brandArg,
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    safe(async ({ stage, include_trays, brand, limit }) => {
      let reels = await listReelSummaries(brand);
      reels = reels.filter((r) => {
        const s = stageOf(r);
        if (stage) return s === stage;
        return include_trays ? true : s !== "rejected" && s !== "done";
      });
      return reels.slice(0, limit ?? 100).map((r) => ({
        id: r.id,
        brand: r.brand,
        stage: stageOf(r),
        status: r.status,
        red_line_flag: r.red_line_flag,
        red_line_reason: r.red_line_reason,
        views: r.views,
        url: r.url,
        source: r.source,
        hook: r.hook,
        planned_post_at: r.planned_post_at,
        post_links: r.post_links,
        slug: r.slug,
        transcript_status: r.transcript_status,
        voiceover_status: r.voiceover_status,
        captions_status: r.captions_status,
        publish_pack_status: r.publish_pack_status,
        has_source_video: r.source_video_path !== null,
        transcript_excerpt: r.transcript_excerpt,
        adapted_script_excerpt: excerpt(r.adapted_script),
        updated_at: r.updated_at,
      }));
    })
  );

  server.registerTool(
    "get_reel",
    {
      description:
        "Full detail for one reel: transcript, structural analysis, adapted script, red-line flag and reason, stage statuses, publish pack, source caption/hashtags — plus `stage` and `allowed_actions` (the tools that are legal for it right now).",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => presentReel(await mustGet(id)))
  );

  server.registerTool(
    "get_media_links",
    {
      description:
        "Signed, short-lived (10 min) URLs for the reel's voiceover mp3 and/or finished video. The video is always the metadata-stripped burn output, never the raw upload. Use these to fetch a file or hand it to the operator.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => {
      const reel = await mustGet(id);
      return {
        audio_url: reel.voiceover_status === "success" && reel.voiceover_path ? mcpMediaUrl(id, "audio") : null,
        video_url:
          reel.kind !== "carousel" && reel.captions_status === "success" && reel.captions_video_path ? mcpMediaUrl(id, "video") : null,
        slide_urls: (reel.slide_paths ?? []).map((_, i) => mcpMediaUrl(id, `slide${i}`)),
        expires_in_minutes: 10,
      };
    })
  );

  server.registerTool(
    "list_scan_logs",
    { description: "Recent discovery scan logs (most recent first).", inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
    safe(async ({ limit }) => listScanLogs(limit ?? 50))
  );

  // ---- Discovery ----
  server.registerTool("list_accounts", { description: "Tracked Instagram accounts for discovery scans." }, safe(async () => listAccounts()));
  server.registerTool(
    "add_account",
    { description: "Track an Instagram account (handle, with or without @) for a brand (default cyrus).", inputSchema: { handle: z.string().min(1), brand: brandArg } },
    safe(async ({ handle, brand }) =>
      withAudit("add_account", "write", { args: { handle, brand } }, () => addAccount(handle.trim(), parseBrand(brand)))
    )
  );
  server.registerTool(
    "set_account_active",
    { description: "Pause or resume scanning a tracked account.", inputSchema: { id: z.number().int().positive(), active: z.boolean() } },
    safe(async ({ id, active }) =>
      withAudit("set_account_active", "write", { args: { id, active } }, async () => {
        await setAccountActive(id, active);
        return { ok: true };
      })
    )
  );
  server.registerTool(
    "remove_account",
    { description: "Stop tracking an account. Reels already found are kept.", inputSchema: { id: z.number().int().positive() } },
    safe(async ({ id }) =>
      withAudit("remove_account", "write", { args: { id } }, async () => {
        await removeAccount(id);
        return { ok: true };
      })
    )
  );

  server.registerTool(
    "list_hashtags",
    { description: "Tracked hashtag and keyword sources for discovery scans (`kind`: hashtag | keyword). Omit brand for all brands.", inputSchema: { brand: brandArg } },
    safe(async ({ brand }) => listHashtags(brand))
  );
  server.registerTool(
    "add_hashtag",
    { description: "Track a hashtag for discovery (with or without #) for a brand (default cyrus).", inputSchema: { tag: z.string().min(1), brand: brandArg } },
    safe(async ({ tag, brand }) =>
      withAudit("add_hashtag", "write", { args: { tag, brand } }, () => addHashtag(tag.trim(), parseBrand(brand)))
    )
  );
  server.registerTool(
    "add_keyword",
    {
      description:
        "Track a keyword source for a brand (default cyrus): the scan searches Instagram reels for the phrase (e.g. \"hifz revision\"), then applies the brand's format filter and view floor like a hashtag. Pause or remove it with set_hashtag_active / remove_hashtag.",
      inputSchema: { keyword: z.string().min(1), brand: brandArg },
    },
    safe(async ({ keyword, brand }) =>
      withAudit("add_keyword", "write", { args: { keyword, brand } }, () => addHashtag(keyword, parseBrand(brand), "keyword"))
    )
  );
  server.registerTool(
    "set_hashtag_active",
    { description: "Pause or resume scanning a tracked hashtag.", inputSchema: { id: z.number().int().positive(), active: z.boolean() } },
    safe(async ({ id, active }) =>
      withAudit("set_hashtag_active", "write", { args: { id, active } }, async () => {
        await setHashtagActive(id, active);
        return { ok: true };
      })
    )
  );
  server.registerTool(
    "remove_hashtag",
    { description: "Stop tracking a hashtag. Reels already found are kept.", inputSchema: { id: z.number().int().positive() } },
    safe(async ({ id }) =>
      withAudit("remove_hashtag", "write", { args: { id } }, async () => {
        await removeHashtag(id);
        return { ok: true };
      })
    )
  );

  server.registerTool(
    "run_scan",
    {
      description:
        "Run a discovery scan over all active accounts, hashtags and keywords now (same as the web app's 'Run scan now'). PAID (treg + Claude format checks) and slow. Capped per day — if refused, do not retry; ask the operator.",
    },
    safe(async () => withAudit("run_scan", "scan", {}, () => runScan()))
  );

  // ---- Pipeline ----
  server.registerTool(
    "add_reel",
    {
      description:
        "Add one Instagram reel by URL (detail + transcript). PAID (treg). Below the view threshold it is NOT saved unless force=true — pass force only if the operator chose this reel. Returns the reel, or {qualifies:false} if below threshold.",
      inputSchema: { url: z.string().url(), force: z.boolean().optional(), brand: brandArg },
    },
    safe(async ({ url, force, brand }) => {
      if (!/instagram\.com\//i.test(url)) throw new Error("Only Instagram URLs are supported.");
      const result = await withAudit("add_reel", "paid", { args: { url, force, brand } }, () => addManualReel(url.trim(), Boolean(force), parseBrand(brand)));
      if (!result.qualifies && !result.forced) {
        return {
          qualifies: false,
          views: result.reel.views,
          message: `Below the ${config.viewThreshold}-view threshold and not saved. Re-call with force=true to track it anyway.`,
        };
      }
      return { reel: presentReel(result.reel), forced: result.forced };
    })
  );

  server.registerTool(
    "add_original",
    {
      description:
        "Add an ORIGINAL item (no scraped source: an app demo, a hook-bank idea) with its draft script. It enters at Script, then goes through adapt_reel and the same approve_script gate as any reel. Free (no paid call). Nuronomics items should carry a hook tag.",
      inputSchema: {
        script: z.string().min(1).describe("The draft script"),
        brand: brandArg,
        hook: hookArg.optional(),
        voiceless: z.boolean().optional().describe("True for an app demo with on-screen text only: no voiceover, Approved goes straight to Video, and burn_captions only strips the upload's metadata"),
        rationale: z.string().min(1).describe("Where this item comes from and why now"),
      },
    },
    safe(async ({ script, brand, hook, voiceless, rationale }) =>
      presentReel(
        await withAudit("add_original", "write", { args: { brand, hook, voiceless, script_chars: script.length }, rationale }, () =>
          addOriginal({ brand: parseBrand(brand), script, hook: (hook as Hook | undefined) ?? null, voiceless })
        )
      )
    )
  );

  server.registerTool(
    "add_carousel",
    {
      description:
        "Add a carousel: derived from an APPROVED reel's script (from_reel_id; takes its hook) or from an original script. It enters at Script; adapt_reel then writes the slides (PAID) under the red-line flag, approve_script approves them with the same rails, and it moves to Slides for the rendered images (create_slides_upload_link).",
      inputSchema: {
        from_reel_id: z.number().int().positive().optional(),
        script: z.string().optional(),
        brand: brandArg,
        hook: hookArg.optional(),
        rationale: z.string().min(1),
      },
    },
    safe(async ({ from_reel_id, script, brand, hook, rationale }) =>
      presentReel(
        await withAudit("add_carousel", "write", { args: { from_reel_id, brand, hook, script_chars: script?.length }, rationale }, () =>
          addCarousel({ brand: parseBrand(brand), fromReelId: from_reel_id, script, hook: (hook as Hook | undefined) ?? null })
        )
      )
    )
  );

  server.registerTool(
    "create_slides_upload_link",
    {
      description:
        "One-off signed URL (15 min) for a carousel's rendered slides, in order: `curl -F slides=@01.png -F slides=@02.png ... <url>`. 2 to 20 PNG/JPG images, each 1080x1350; they are metadata-stripped and the carousel moves to Finished. Carousel must be in the Slides column.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => {
      const reel = await mustGet(id);
      if (reel.kind !== "carousel" || reel.status !== "slides") throw new Error(`Item ${id} is not a carousel waiting for slides.`);
      return { upload_url: uploadUrl(id), method: "POST multipart/form-data, repeated field 'slides' in order", expires_in_minutes: 15 };
    })
  );

  server.registerTool(
    "add_story",
    {
      description:
        "Add the day's story: a short description of what it shows, plus the rendered image or short video uploaded through the returned upload_url (field 'video', any of PNG/JPG/WebP/MP4/MOV; stripped on upload). It starts in Pending approval and can only be scheduled after approve_item.",
      inputSchema: { text: z.string().min(1), brand: brandArg, hook: hookArg.optional(), rationale: z.string().min(1) },
    },
    safe(async ({ text, brand, hook, rationale }) => {
      const reel = await withAudit("add_story", "write", { args: { brand, hook, text }, rationale }, () =>
        addStory({ brand: parseBrand(brand), text, hook: (hook as Hook | undefined) ?? null })
      );
      return { ...presentReel(reel), upload_url: uploadUrl(reel.id), upload_expires_in_minutes: 15 };
    })
  );

  server.registerTool(
    "add_text_post",
    {
      description:
        "Add a text post (a WhatsApp Channel post, WhatsApp Community message, email or prelaunch piece) with its channel and body. It starts in Pending approval and can only be scheduled after approve_item. The app never sends it.",
      inputSchema: {
        channel: z.enum(TEXT_CHANNELS as [string, ...string[]]),
        body: z.string().min(1),
        brand: brandArg,
        hook: hookArg.optional(),
        rationale: z.string().min(1),
      },
    },
    safe(async ({ channel, body, brand, hook, rationale }) =>
      presentReel(
        await withAudit("add_text_post", "write", { args: { brand, hook, channel, body_chars: body.length }, rationale }, () =>
          addTextPost({ brand: parseBrand(brand), channel, body, hook: (hook as Hook | undefined) ?? null })
        )
      )
    )
  );

  server.registerTool(
    "approve_item",
    {
      description:
        "APPROVAL GATE for a story or text post: Pending approval → Finished (then schedule_item). ALWAYS ask the operator on Telegram first (show the story or the text), and pass operator_confirmed=true with confirmation_note quoting their reply — refused otherwise.",
      inputSchema: {
        id: reelId,
        rationale: z.string().min(1),
        operator_confirmed: z.boolean(),
        confirmation_note: z.string().min(1).describe("The operator's Telegram reply, quoted"),
      },
    },
    safe(async ({ id, rationale, operator_confirmed, confirmation_note }) =>
      presentReel(
        await withAudit(
          "approve_item",
          "write",
          { reelId: id, args: { id, operator_confirmed, confirmation_note }, rationale },
          async () => {
            if (!operator_confirmed || !confirmation_note.trim()) {
              throw new Error(
                `Approving item ${id} needs the operator's word. Ask on Telegram, then re-call with operator_confirmed=true and confirmation_note quoting their reply.`
              );
            }
            return approveItem(id);
          }
        )
      )
    )
  );

  // ---- Operator digest (ticket 14) ----
  server.registerTool(
    "get_operator_queue",
    {
      description:
        "Everything waiting on the operator, split by brand, for the daily 07:30 digest: scripts awaiting approval (with red-line flag and reason), stories and text posts pending approval, today's ready posts of every kind (full payload), engagement drafts awaiting approval (numbered by id) and approved ones awaiting sending, and failed steps. Read-only. Add the Hifdh ticket tasks yourself.",
      inputSchema: {
        timezone: z.string().optional().describe("IANA zone that defines 'today'; default Asia/Kolkata"),
      },
    },
    safe(async ({ timezone }) => {
      const tz = timezone ?? "Asia/Kolkata";
      // Today's bounds in that zone, as UTC instants.
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
      const offsetOf = (d: Date) => {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d);
        const off = parts.find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
        return off === "" ? "+00:00" : off;
      };
      const start = new Date(`${day}T00:00:00${offsetOf(new Date())}`);
      const end = new Date(start.getTime() + 864e5);

      const reels = await listReelSummaries();
      const scheduled = await listScheduled(start, end);
      const engagement = await listEngagement({});
      const brief = (r: (typeof reels)[number]) => ({ id: r.id, kind: r.kind, slug: r.slug, hook: r.hook, status: r.status });
      const out: Record<string, unknown> = {};
      for (const { id: brand } of BRANDS) {
        const mine = reels.filter((r) => r.brand === brand);
        out[brand] = {
          scripts_awaiting_approval: mine
            .filter((r) => r.status === "adapted")
            .map((r) => ({ ...brief(r), red_line_flag: r.red_line_flag, red_line_reason: r.red_line_reason, script_excerpt: excerpt(r.adapted_script) })),
          items_pending_approval: mine.filter((r) => r.status === "pending_approval").map(brief),
          ready_posts_today: scheduled.filter((r) => r.brand === brand).map(readyPost),
          engagement_awaiting_approval: engagement
            .filter((e) => e.brand === brand && e.status === "draft")
            .map((e) => ({ number: e.id, kind: e.kind, platform: e.platform, target_url: e.target_url, context: e.context, draft: e.draft })),
          engagement_awaiting_send: engagement
            .filter((e) => e.brand === brand && e.status === "approved")
            .map((e) => ({ number: e.id, platform: e.platform, target_url: e.target_url, text: e.approved_text })),
          failed_steps: mine
            .filter((r) => r.status !== "rejected" && r.status !== "archived")
            .flatMap((r) => [
              r.transcript_status === "failed" && r.source !== "original" ? { ...brief(r), step: "transcript" } : null,
              r.voiceover_status === "failed" ? { ...brief(r), step: "voiceover", error: r.voiceover_error } : null,
              r.captions_status === "failed" ? { ...brief(r), step: "captions", error: r.captions_error } : null,
              r.publish_pack_status === "failed" ? { ...brief(r), step: "publish_pack", error: r.publish_pack_error } : null,
            ])
            .filter(Boolean),
        };
      }
      return { day, timezone: tz, brands: out };
    })
  );

  // ---- Metrics (reading insights is not posting) ----
  server.registerTool(
    "record_metrics",
    {
      description:
        "Record one reading for a POSTED item: views, 3-second rate (0-1), saves, comments, shares, on a platform at a date (default now). Readings build up week by week; refused for anything not posted. Public Instagram counts are also read weekly by the app's own cron.",
      inputSchema: {
        id: reelId,
        platform: z.enum(POST_PLATFORMS as [string, ...string[]]),
        read_at: z.string().optional(),
        views: z.number().int().nonnegative().optional(),
        three_second_rate: z.number().min(0).max(1).optional(),
        saves: z.number().int().nonnegative().optional(),
        comments: z.number().int().nonnegative().optional(),
        shares: z.number().int().nonnegative().optional(),
        rationale: z.string().min(1).describe("Where the numbers come from (insights screenshot, Taha's message)"),
      },
    },
    safe(async ({ id, rationale, ...m }) =>
      withAudit("record_metrics", "write", { reelId: id, args: { id, ...m }, rationale }, async () => ({
        recorded: await recordMetrics(id, m),
        readings: await listMetrics(id),
      }))
    )
  );

  server.registerTool(
    "get_hook_summary",
    {
      description:
        "The three-hook test so far, per hook (A, B, C, untagged) over posted items: items posted, median views and median 3-second rate (each item's latest reading), total saves and comments; plus month-to-date paid spend (treg in USD, agent paid calls by count). For the Friday digest.",
      inputSchema: { brand: brandArg },
    },
    safe(async ({ brand }) => hookSummary(brand))
  );

  // ---- Engagement queue (no send tool: the operator sends by hand) ----
  server.registerTool(
    "draft_engagement",
    {
      description:
        "Save a drafted reply, comment or DM for the operator to approve: platform, the link it answers, the text it answers (context), your draft and why. Capped per platform per day. The app never sends; the operator pastes it by hand after approve_engagement.",
      inputSchema: {
        brand: brandArg,
        kind: z.enum(ENGAGEMENT_KINDS as [string, ...string[]]),
        platform: z.enum(ENGAGEMENT_PLATFORMS),
        target_url: z.string().url(),
        context: z.string().min(1).describe("The post or comment this answers, quoted"),
        draft: z.string().min(1),
        reel_id: z.number().int().positive().optional().describe("Board item it promotes, if any"),
        rationale: z.string().min(1),
      },
    },
    safe(async ({ brand, kind, platform, target_url, context, draft, reel_id, rationale }) =>
      withAudit("draft_engagement", "write", { reelId: reel_id ?? null, args: { brand, kind, platform, target_url }, rationale }, () =>
        draftEngagement({
          brand: parseBrand(brand), kind: kind as EngagementKind, platform: platform as EngagementPlatform,
          target_url, context, draft, reel_id, rationale,
        })
      )
    )
  );

  server.registerTool(
    "list_engagement",
    {
      description:
        "Engagement drafts, oldest first. `id` is the stable number to quote to the operator (\"#12\"). Status: draft, approved, sent, dropped, or expired (approved over 48h ago and never sent).",
      inputSchema: { brand: brandArg, status: z.enum(["draft", "approved", "sent", "dropped", "expired"]).optional() },
    },
    safe(async ({ brand, status }) => listEngagement({ brand, status: status as EngagementStatus | undefined }))
  );

  server.registerTool(
    "approve_engagement",
    {
      description:
        "APPROVAL GATE for an engagement draft. ALWAYS ask the operator on Telegram first (show the context and draft); pass operator_confirmed=true and confirmation_note quoting their reply, and approved_text if they changed the wording (it is kept as approved). Refused otherwise. Approval does not send anything.",
      inputSchema: {
        id: z.number().int().positive(),
        rationale: z.string().min(1),
        operator_confirmed: z.boolean(),
        confirmation_note: z.string().min(1).describe("The operator's Telegram reply, quoted"),
        approved_text: z.string().optional().describe("The wording the operator approved, if they edited it"),
      },
    },
    safe(async ({ id, rationale, operator_confirmed, confirmation_note, approved_text }) =>
      withAudit("approve_engagement", "write", { args: { id, operator_confirmed, confirmation_note, edited: approved_text !== undefined }, rationale }, async () => {
        if (!operator_confirmed || !confirmation_note.trim()) {
          throw new Error(
            `Approving draft ${id} needs the operator's word. Ask on Telegram, then re-call with operator_confirmed=true and confirmation_note quoting their reply.`
          );
        }
        return approveEngagement(id, approved_text ?? null, confirmation_note);
      })
    )
  );

  server.registerTool(
    "drop_engagement",
    {
      description: "Drop an engagement draft with a reason (stale thread, the operator said no, off-brand).",
      inputSchema: { id: z.number().int().positive(), reason: z.string().min(1) },
    },
    safe(async ({ id, reason }) =>
      withAudit("drop_engagement", "write", { args: { id }, rationale: reason }, () => dropEngagement(id, reason))
    )
  );

  server.registerTool(
    "mark_sent",
    {
      description:
        "Record that the OPERATOR pasted and sent an approved draft by hand. Only after they say so. Refused for a draft that is not approved or expired (approved over 48h ago).",
      inputSchema: { id: z.number().int().positive(), rationale: z.string().min(1).describe("How you know it was sent, e.g. the operator's reply") },
    },
    safe(async ({ id, rationale }) => withAudit("mark_sent", "write", { args: { id }, rationale }, () => markSent(id)))
  );

  server.registerTool(
    "set_hook",
    {
      description: "Tag a reel with the launch hook it tests (A / B / C), or clear the tag with hook=null.",
      inputSchema: { id: reelId, hook: hookArg.nullable(), rationale: z.string().min(1) },
    },
    safe(async ({ id, hook, rationale }) => {
      await mustGet(id);
      await withAudit("set_hook", "write", { reelId: id, args: { id, hook }, rationale }, () => setHook(id, hook as Hook | null));
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "retry_transcript",
    {
      description: "Re-pull the transcript for a reel whose transcript failed. PAID (treg) — one call, one pull; don't loop on failure, report it.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("retry_transcript", "paid", { reelId: id, args: { id } }, () => retrieveTranscript(id)))
    )
  );

  server.registerTool(
    "accept_reel",
    {
      description: "Scraped → Script. The triage decision that a reel is worth adapting. Mints the reel's file slug.",
      inputSchema: { id: reelId, rationale: z.string().min(1).describe("Why this reel is worth adapting") },
    },
    safe(async ({ id, rationale }) =>
      presentReel(await withAudit("accept_reel", "write", { reelId: id, args: { id }, rationale }, () => acceptReel(id)))
    )
  );

  server.registerTool(
    "edit_reel",
    {
      description:
        "Hand-edit a reel's transcript, adapted_script and/or publish_pack (the whole pack object, saved as-is). Editing the adapted script does not re-run anything; regenerate the publish pack afterwards if the script changed materially. Any red-line edits are yours to justify in `rationale`.",
      inputSchema: {
        id: reelId,
        transcript: z.string().optional(),
        adapted_script: z.string().optional(),
        publish_pack: z.record(z.string(), z.unknown()).optional(),
        rationale: z.string().min(1),
      },
    },
    safe(async ({ id, transcript, adapted_script, publish_pack, rationale }) => {
      if (transcript === undefined && adapted_script === undefined && publish_pack === undefined) {
        throw new Error("Provide at least one of transcript, adapted_script, publish_pack.");
      }
      await mustGet(id);
      await withAudit("edit_reel", "write", { reelId: id, args: { id, fields: Object.keys({ transcript, adapted_script, publish_pack }).filter((k) => ({ transcript, adapted_script, publish_pack } as Record<string, unknown>)[k] !== undefined) }, rationale }, () =>
        updateEditable(id, { transcript, adapted_script, publish_pack: publish_pack as unknown as PublishPack | undefined })
      );
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "adapt_reel",
    {
      description:
        "Run the red-line-compliance adaptation (minimal edits, no voice rewrite) on the reel's transcript. PAID (Claude API) — one call, one generation; don't loop, report failures. Sets red_line_flag (none / needs_review / rejected) — read the flag and reason before approving.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("adapt_reel", "paid", { reelId: id, args: { id } }, () => adaptReel(id)))
    )
  );

  server.registerTool(
    "approve_script",
    {
      description:
        "APPROVAL GATE: Adaptation → Audio. Only valid while status is 'adapted'. Read the adapted script and red-line flag first, and give a `rationale`. " +
        "red_line_flag 'none': you may approve. " +
        "'needs_review': ASK THE OPERATOR ON TELEGRAM first (show the script and the flag reason); only after they say yes, call with operator_confirmed=true and confirmation_note quoting their reply. " +
        "'rejected': you may NOT approve — tell the operator; they approve in the web app or Instagram bot. " +
        "In any doubt, ask on Telegram instead of approving.",
      inputSchema: {
        id: reelId,
        rationale: z.string().min(1),
        operator_confirmed: z.boolean().optional(),
        confirmation_note: z.string().optional().describe("The operator's Telegram reply, quoted"),
      },
    },
    safe(async ({ id, rationale, operator_confirmed, confirmation_note }) => {
      // The gate checks live inside withAudit so a REFUSED approval is
      // recorded (ok=false) just like a successful one.
      await withAudit(
        "approve_script",
        "write",
        { reelId: id, args: { id, operator_confirmed: Boolean(operator_confirmed), confirmation_note }, rationale },
        async () => {
          const reel = await mustGet(id);
          if (reel.status !== "adapted") {
            throw new Error(`Reel ${id} is in "${reel.status}", not "adapted" — nothing to approve.`);
          }
          if (!reel.adapted_script?.trim()) throw new Error("Reel has no adapted script to approve.");
          if (reel.red_line_flag === "rejected") {
            throw new Error(
              `Reel ${id} is flagged 'rejected' (${reel.red_line_reason ?? "no reason given"}). You cannot approve it — report this to the operator on Telegram; they can approve in the web app or Instagram bot.`
            );
          }
          if (reel.red_line_flag === "needs_review" && (!operator_confirmed || !confirmation_note?.trim())) {
            throw new Error(
              `Reel ${id} is flagged 'needs_review' (${reel.red_line_reason ?? "no reason given"}). Ask the operator on Telegram, then re-call with operator_confirmed=true and confirmation_note set to their reply.`
            );
          }
          // Same function the web PATCH route and the Instagram bot use for
          // this transition; it clears the red-line flag as the
          // human-resolved call.
          await setStatus(id, "approved");
        }
      );
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "reject_reel",
    {
      description: "Reject a reel from any stage (moves to the Rejected tray; restore_reel undoes it).",
      inputSchema: { id: reelId, reason: z.string().min(1) },
    },
    safe(async ({ id, reason }) => {
      const reel = await mustGet(id);
      if (reel.status === "rejected" || reel.status === "archived") {
        throw new Error(`Reel ${id} is already ${reel.status}.`);
      }
      await withAudit("reject_reel", "write", { reelId: id, args: { id }, rationale: reason }, () => setStatus(id, "rejected"));
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "archive_reel",
    {
      description:
        "Archive a finished (Subtitled or Posted) reel to free disk. To record that a reel was posted, use mark_posted instead — that keeps the files. IRREVERSIBLE FILE DELETE: this permanently purges the reel's whole file folder (voiceover, source video, subtitled video) from disk to reclaim volume space — not just a kanban move. Only the adapted script/publish pack text survives in the DB; restore_reel can bring the reel row back but NOT its files. " +
        "Because this destroys data, the agent must ALWAYS get explicit operator confirmation on Telegram first (never infer 'this was probably posted') and pass operator_confirmed=true with confirmation_note quoting their reply — the call is refused otherwise, regardless of stage or red_line_flag.",
      inputSchema: {
        id: reelId,
        rationale: z.string().min(1).describe("Why this reel is being archived now (e.g. confirmed posted to Instagram)"),
        operator_confirmed: z.boolean(),
        confirmation_note: z.string().min(1).describe("The operator's Telegram reply, quoted"),
      },
    },
    safe(async ({ id, rationale, operator_confirmed, confirmation_note }) => {
      return presentReel(
        await withAudit(
          "archive_reel",
          "write",
          { reelId: id, args: { id, operator_confirmed, confirmation_note }, rationale },
          async () => {
            if (!operator_confirmed || !confirmation_note.trim()) {
              throw new Error(
                `Archiving reel ${id} permanently deletes its files. Ask the operator on Telegram first, then re-call with operator_confirmed=true and confirmation_note set to their reply.`
              );
            }
            const reel = await mustGet(id);
            if (reel.status !== "captioned" && reel.status !== "posted") {
              throw new Error(`Only a Subtitled or Posted reel can be archived; reel ${id} is "${reel.status}".`);
            }
            return archiveReel(id);
          }
        )
      );
    })
  );

  server.registerTool(
    "restore_reel",
    {
      description: "Bring a rejected (or archived) reel back onto the board, to the column it came from.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("restore_reel", "write", { reelId: id, args: { id } }, () => restoreReel(id)))
    )
  );

  server.registerTool(
    "move_back",
    {
      description: "Move a reel back one kanban column (e.g. Audio → Adaptation to redo a script). Files already generated are kept.",
      inputSchema: { id: reelId, reason: z.string().min(1) },
    },
    safe(async ({ id, reason }) => {
      const reel = await mustGet(id);
      const stage = stageOf(reel);
      if (stage === "rejected" || stage === "done") throw new Error("Use restore_reel for rejected/archived reels.");
      const target = backTargetStatus(reel, stage as Stage);
      if (!target) throw new Error("This reel is already in the first column.");
      await withAudit("move_back", "write", { reelId: id, args: { id, from: reel.status, to: target }, rationale: reason }, () =>
        advanceStatus(id, target)
      );
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "schedule_item",
    {
      description:
        "Record the planned post time for a finished (Subtitled) item, or move an already scheduled one (Subtitled → Scheduled). Bookkeeping only: the app never posts; the operator publishes by hand. Use the time the operator agreed.",
      inputSchema: {
        id: reelId,
        planned_post_at: z.string().min(1).describe("ISO 8601 date-time with offset, e.g. 2026-10-24T18:00:00+01:00"),
        rationale: z.string().min(1),
      },
    },
    safe(async ({ id, planned_post_at, rationale }) =>
      presentReel(
        await withAudit("schedule_item", "write", { reelId: id, args: { id, planned_post_at }, rationale }, () =>
          scheduleItem(id, planned_post_at)
        )
      )
    )
  );

  server.registerTool(
    "unschedule_item",
    {
      description: "Take a Scheduled item off the schedule, back to its finished column (planned time cleared). Nothing else changes.",
      inputSchema: { id: reelId, rationale: z.string().min(1) },
    },
    safe(async ({ id, rationale }) =>
      presentReel(await withAudit("unschedule_item", "write", { reelId: id, args: { id }, rationale }, () => unscheduleItem(id)))
    )
  );

  server.registerTool(
    "list_ready_posts",
    {
      description:
        "Ready posts: Scheduled items due in a time window (default: the last 24 hours, for anything overdue, to the next 24), soonest first, each with everything the operator needs to post by hand: a signed file link (10 min), caption, hashtags and cover text from the publish pack. The app never posts.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 date-time; default now minus 24h"),
        to: z.string().optional().describe("ISO 8601 date-time; default now plus 24h"),
        brand: brandArg,
      },
    },
    safe(async ({ from, to, brand }) => {
      const now = Date.now();
      const start = new Date(from ?? now - 864e5);
      const end = new Date(to ?? now + 864e5);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("from/to must be ISO date-times.");
      return (await listScheduled(start, end, brand)).map(readyPost);
    })
  );

  server.registerTool(
    "mark_posted",
    {
      description:
        "Record that the OPERATOR published this item by hand, with one live https link per platform (Subtitled/Scheduled → Posted; on a Posted item it adds a cross-post). " +
        "Never infer that something went out: ASK THE OPERATOR ON TELEGRAM, use only the link(s) they reply with, and pass operator_confirmed=true with confirmation_note quoting their reply — refused otherwise. Keeps all files (unlike archive_reel).",
      inputSchema: {
        id: reelId,
        links: z
          .array(z.object({ platform: z.enum(POST_PLATFORMS as [string, ...string[]]), url: z.string().url() }))
          .describe("One entry per platform. May be empty only for an email text post, which has no link."),
        rationale: z.string().min(1),
        operator_confirmed: z.boolean(),
        confirmation_note: z.string().min(1).describe("The operator's Telegram reply, quoted"),
      },
    },
    safe(async ({ id, links, rationale, operator_confirmed, confirmation_note }) =>
      presentReel(
        await withAudit(
          "mark_posted",
          "write",
          { reelId: id, args: { id, links, operator_confirmed, confirmation_note }, rationale },
          async () => {
            if (!operator_confirmed || !confirmation_note.trim()) {
              throw new Error(
                `Marking reel ${id} posted needs the operator's word. Ask on Telegram, then re-call with operator_confirmed=true and confirmation_note quoting their reply.`
              );
            }
            return markPosted(id, links);
          }
        )
      )
    )
  );

  server.registerTool(
    "generate_voiceover",
    {
      description:
        "Generate the ElevenLabs voiceover for an APPROVED script. PAID — one call, one generation; on failure report it, don't retry. Blocked automatically if the script exceeds the character cap.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("generate_voiceover", "paid", { reelId: id, args: { id } }, () => generateVoiceover(id)))
    )
  );

  server.registerTool(
    "send_to_video",
    {
      description:
        "Audio → Video stage, once the voiceover exists. After this the operator (or you) produces the HeyGen video from the voiceover — that generation is manual — then upload it with upload_video_from_url or create_video_upload_link.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => {
      const reel = await mustGet(id);
      if (reel.status !== "approved") throw new Error(`Reel ${id} is in "${reel.status}", not "approved".`);
      if (!reel.voiceless && reel.voiceover_status !== "success") throw new Error("Generate the voiceover first.");
      await withAudit("send_to_video", "write", { reelId: id, args: { id } }, () => advanceStatus(id, "video"));
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "upload_video_from_url",
    {
      description:
        "Attach the finished HeyGen/edited video by public https URL (server downloads it, size-capped). Reel must be in the Video stage. Does not burn subtitles — call burn_captions next. For a local file, use create_video_upload_link instead.",
      inputSchema: { id: reelId, url: z.string().url() },
    },
    safe(async ({ id, url }) => {
      await withAudit("upload_video_from_url", "write", { reelId: id, args: { id, url } }, async () => {
        const buffer = await downloadVideo(url);
        return saveSourceVideo(id, buffer);
      });
      return presentReel(await mustGet(id));
    })
  );

  server.registerTool(
    "create_video_upload_link",
    {
      description:
        "Get a one-off signed URL (15 min) for uploading a file from local disk: `curl -F video=@file.mp4 <url>`. A reel must be in the Video stage (then call burn_captions). A story takes its rendered image or short video (PNG, JPG, WebP, MP4, MOV) while pending approval; it is metadata-stripped on upload.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => {
      const reel = await mustGet(id);
      const storyOk = reel.kind === "story" && reel.status === "pending_approval";
      if (reel.status !== "video" && !storyOk) throw new Error('Send this reel to the "Video" stage first (send_to_video).');
      return { upload_url: uploadUrl(id), method: "POST multipart/form-data, field 'video'", expires_in_minutes: 15, max_mb: config.captionsMaxVideoMb };
    })
  );

  server.registerTool(
    "burn_captions",
    {
      description:
        "Burn word-synced subtitles onto the uploaded video AND strip its metadata in one pass, producing the finished file (Video → Subtitled). For a voiceless original it only strips the metadata (no burn). Slow (minutes). Requires an uploaded video and a voiceover. Don't retry on failure; report captions_error.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("burn_captions", "write", { reelId: id, args: { id } }, () => burnCaptions(id)))
    )
  );

  server.registerTool(
    "generate_publish_pack",
    {
      description:
        "Generate SUGGESTED Instagram caption, hashtags and cover-text hook from the current adapted script. PAID (Claude API). Suggestions only — nothing is ever posted, and choosing/editing the final caption, tags and the AI-content toggle stay with the operator. Re-run after editing the script.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("generate_publish_pack", "paid", { reelId: id, args: { id } }, () => generatePublishPack(id)))
    )
  );
}
