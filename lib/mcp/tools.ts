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
} from "../reels";
import {
  acceptReel,
  addManualReel,
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
import type { Reel, PublishPack } from "../types";
import { withAudit } from "./audit";
import { downloadVideo } from "./download";
import { uploadUrl } from "./uploadToken";

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
      a.push(reel.voiceover_status === "success" ? "send_to_video" : "generate_voiceover", "edit_reel", "reject_reel", "move_back");
      if (reel.voiceover_status === "success") a.push("generate_voiceover");
      break;
    case "video":
      if (!reel.source_video_path) a.push("upload_video_from_url", "create_video_upload_link");
      else a.push("burn_captions");
      a.push("reject_reel", "move_back");
      break;
    case "captioned":
      a.push("get_media_links", "generate_publish_pack", "edit_reel", "reject_reel", "move_back", "archive_reel");
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

const excerpt = (s: string | null, n = 240) => (s && s.length > n ? s.slice(0, n) + "…" : s);

// --- registration --------------------------------------------------------

export function registerTools(server: McpServer): void {
  // ---- Read (free) ----
  server.registerTool(
    "get_pipeline_overview",
    {
      description:
        "Start here. Counts of reels per kanban stage, plus the reels currently waiting on a decision or action (awaiting accept, awaiting approval, awaiting video upload, ready to burn) and any with a red-line flag.",
    },
    safe(async () => {
      const reels = await listReelSummaries();
      const counts: Record<string, number> = {};
      const brief = (r: (typeof reels)[number]) => ({
        id: r.id,
        status: r.status,
        red_line_flag: r.red_line_flag,
        views: r.views,
        slug: r.slug,
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
        stage: z.enum(["scraped", "script", "adaptation", "audio", "video", "subtitled", "rejected", "done"]).optional(),
        include_trays: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    safe(async ({ stage, include_trays, limit }) => {
      let reels = await listReelSummaries();
      reels = reels.filter((r) => {
        const s = stageOf(r);
        if (stage) return s === stage;
        return include_trays ? true : s !== "rejected" && s !== "done";
      });
      return reels.slice(0, limit ?? 100).map((r) => ({
        id: r.id,
        stage: stageOf(r),
        status: r.status,
        red_line_flag: r.red_line_flag,
        red_line_reason: r.red_line_reason,
        views: r.views,
        url: r.url,
        source: r.source,
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
        video_url: reel.captions_status === "success" && reel.captions_video_path ? mcpMediaUrl(id, "video") : null,
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
    { description: "Track an Instagram account (handle, with or without @).", inputSchema: { handle: z.string().min(1) } },
    safe(async ({ handle }) =>
      withAudit("add_account", "write", { args: { handle } }, () => addAccount(handle.trim()))
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

  server.registerTool("list_hashtags", { description: "Tracked hashtags for discovery scans." }, safe(async () => listHashtags()));
  server.registerTool(
    "add_hashtag",
    { description: "Track a hashtag for discovery (with or without #).", inputSchema: { tag: z.string().min(1) } },
    safe(async ({ tag }) =>
      withAudit("add_hashtag", "write", { args: { tag } }, () => addHashtag(tag.trim()))
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
        "Run a discovery scan over all active accounts and hashtags now (same as the web app's 'Run scan now'). PAID (Apify) and slow. Capped per day — if refused, do not retry; ask the operator.",
    },
    safe(async () => withAudit("run_scan", "scan", {}, () => runScan()))
  );

  // ---- Pipeline ----
  server.registerTool(
    "add_reel",
    {
      description:
        "Add one Instagram reel by URL (scrape + transcript). PAID (Apify). Below the view threshold it is NOT saved unless force=true — pass force only if the operator chose this reel. Returns the reel, or {qualifies:false} if below threshold.",
      inputSchema: { url: z.string().url(), force: z.boolean().optional() },
    },
    safe(async ({ url, force }) => {
      if (!/instagram\.com\//i.test(url)) throw new Error("Only Instagram URLs are supported.");
      const result = await withAudit("add_reel", "paid", { args: { url, force } }, () => addManualReel(url.trim(), Boolean(force)));
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
    "retry_transcript",
    {
      description: "Re-pull the transcript for a reel whose transcript failed. PAID (Apify) — one call, one pull; don't loop on failure, report it.",
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
        "Run the red-line-compliance adaptation (minimal edits, no voice rewrite) on the reel's transcript. PAID (Gemini) — one call, one generation; don't loop, report failures. Sets red_line_flag (none / needs_review / rejected) — read the flag and reason before approving.",
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
        "Archive a finished (Subtitled-stage) reel as posted. IRREVERSIBLE FILE DELETE: this permanently purges the reel's whole file folder (voiceover, source video, subtitled video) from disk to reclaim volume space — not just a kanban move. Only the adapted script/publish pack text survives in the DB; restore_reel can bring the reel row back but NOT its files. " +
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
            if (reel.status === "archived") throw new Error(`Reel ${id} is already archived.`);
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
      if (reel.voiceover_status !== "success") throw new Error("Generate the voiceover first.");
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
        "Get a one-off signed URL (15 min) for uploading the finished video from a local file: `curl -F video=@file.mp4 <url>`. Reel must be in the Video stage. Then call burn_captions.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) => {
      const reel = await mustGet(id);
      if (reel.status !== "video") throw new Error('Send this reel to the "Video" stage first (send_to_video).');
      return { upload_url: uploadUrl(id), method: "POST multipart/form-data, field 'video'", expires_in_minutes: 15, max_mb: config.captionsMaxVideoMb };
    })
  );

  server.registerTool(
    "burn_captions",
    {
      description:
        "Burn word-synced subtitles onto the uploaded video AND strip its metadata in one pass, producing the finished file (Video → Subtitled). Slow (minutes). Requires an uploaded video and a voiceover. Don't retry on failure; report captions_error.",
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
        "Generate SUGGESTED Instagram caption, hashtags and cover-text hook from the current adapted script. PAID (Gemini). Suggestions only — nothing is ever posted, and choosing/editing the final caption, tags and the AI-content toggle stay with the operator. Re-run after editing the script.",
      inputSchema: { id: reelId },
    },
    safe(async ({ id }) =>
      presentReel(await withAudit("generate_publish_pack", "paid", { reelId: id, args: { id } }, () => generatePublishPack(id)))
    )
  );
}
