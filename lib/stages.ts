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
  | "subtitled";

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
    id: "subtitled",
    title: "Subtitled",
    blurb: "Finished, metadata-stripped file — ready to download.",
    statuses: ["captioned"],
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
