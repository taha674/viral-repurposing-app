// Single source of truth mapping a reel's status to its kanban column. The
// board, the cards, and the stage popup all dispatch off stageOf() so they
// can never disagree about which column/controls a reel belongs in.

import type { Reel, ReelStatus } from "./types";

export type Stage =
  | "scraped"
  | "script"
  | "adaptation"
  | "audio"
  | "video"
  | "slides"
  | "pending"
  | "subtitled"
  | "scheduled"
  | "posted";

export type Placement = Stage | "rejected" | "done";

export const STAGES: { id: Stage; title: string; blurb: string; statuses: ReelStatus[] }[] = [
  {
    id: "scraped",
    title: "Scraped",
    blurb: "Discovered reels awaiting accept/reject.",
    statuses: ["new", "transcribed"],
  },
  {
    id: "script",
    title: "Script",
    blurb: "Accepted — ready for red-line-compliance adaptation.",
    statuses: ["accepted"],
  },
  {
    id: "adaptation",
    title: "Adaptation",
    blurb: "Adapted — awaiting approval.",
    statuses: ["adapted"],
  },
  {
    id: "audio",
    title: "Audio",
    blurb: "Approved — generate and review the voiceover.",
    statuses: ["approved"],
  },
  {
    id: "video",
    title: "Video",
    blurb: "Upload the finished HeyGen video, then burn subtitles.",
    statuses: ["video"],
  },
  {
    id: "slides",
    title: "Slides",
    blurb: "Carousels: approved slides waiting for their rendered images.",
    statuses: ["slides"],
  },
  {
    id: "pending",
    title: "Pending approval",
    blurb: "Stories and text posts waiting for the operator's approval.",
    statuses: ["pending_approval"],
  },
  {
    id: "subtitled",
    title: "Finished",
    blurb: "Subtitled and metadata-stripped, or an approved story or text post. Ready to schedule.",
    statuses: ["captioned"],
  },
  {
    id: "scheduled",
    title: "Scheduled",
    blurb: "Post time picked — the operator publishes by hand.",
    statuses: ["scheduled"],
  },
  {
    id: "posted",
    title: "Posted",
    blurb: "Published by the operator. Files kept (Archive deletes them).",
    statuses: ["posted"],
  },
];

const STATUS_TO_STAGE = new Map<ReelStatus, Stage>();
for (const s of STAGES) {
  for (const status of s.statuses) STATUS_TO_STAGE.set(status, s.id);
}

export function stageOf(reel: Pick<Reel, "status">): Placement {
  if (reel.status === "rejected") return "rejected";
  if (reel.status === "archived") return "done";
  const stage = STATUS_TO_STAGE.get(reel.status);
  if (!stage) {
    throw new Error(`Unmapped reel status: ${reel.status}`);
  }
  return stage;
}

// The column immediately to the left of `stage`, or null for Scraped (there
// is nothing before it). Backs the "Move back" control in StageModal.
export function previousStage(stage: Stage): Stage | null {
  const idx = STAGES.findIndex((s) => s.id === stage);
  if (idx <= 0) return null;
  return STAGES[idx - 1].id;
}

// The status to set when moving a reel back one column. Scraped is the only
// column with two statuses ("new" vs "transcribed"), so that case is
// inferred from whether a transcript is already on record — same inference
// restoreReel() uses for the Rejected-tray fallback. Posted goes back to
// Scheduled only if it was ever scheduled (posting straight from Subtitled
// is allowed), so a Scheduled card always has a time.
export function backTargetStatus(
  reel: Pick<Reel, "transcript_status" | "planned_post_at" | "kind">,
  stage: Stage
): ReelStatus | null {
  // Stories and text posts have only Pending approval before Finished.
  if (reel.kind === "story" || reel.kind === "text") {
    if (stage === "pending") return null;
    if (stage === "subtitled") return "pending_approval";
  }
  if (reel.kind === "carousel") {
    if (stage === "slides") return "adapted";
    if (stage === "subtitled") return "slides";
  }
  if (stage === "pending" || stage === "slides") return null;
  if (stage === "subtitled") return "video";
  const prev = previousStage(stage);
  if (!prev) return null;
  if (prev === "scraped") {
    return reel.transcript_status === "success" ? "transcribed" : "new";
  }
  if (prev === "scheduled" && !reel.planned_post_at) return "captioned";
  return STAGES.find((s) => s.id === prev)!.statuses[0];
}
