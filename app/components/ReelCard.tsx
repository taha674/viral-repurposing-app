"use client";

import type { ReelSummary } from "@/lib/types";
import type { Stage } from "@/lib/stages";
import { FlagBadge } from "./Badges";
import styles from "../board.module.css";

// One card per reel. Excerpt shown depends on the stage: Scraped/Script show
// the transcript (all that exists yet), everything from Adaptation onward
// shows the adapted script. Scraped cards get inline Accept/Reject for fast
// triage — every other stage's actions live behind the popup only, per the
// "buttons only, no drag" decision (keeps the red-line approval gate real).
export default function ReelCard({
  reel,
  stage,
  onOpen,
  onAccept,
  onReject,
  busy,
}: {
  reel: ReelSummary;
  stage: Stage;
  onOpen: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  busy: boolean;
}) {
  const title = reel.slug ?? reel.shortcode ?? reel.url.slice(0, 32);
  const excerpt =
    stage === "scraped" || stage === "script"
      ? reel.transcript_excerpt
      : reel.adapted_script?.slice(0, 160) ?? null;

  return (
    <div className={styles.card} onClick={onOpen}>
      {reel.thumbnail_url && (
        <img
          className={styles.cardThumb}
          src={reel.thumbnail_url}
          alt=""
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <div className={styles.cardTop}>
        <div className={styles.cardTitle}>{title}</div>
      </div>
      <div className={styles.cardMeta}>
        <span>{reel.views?.toLocaleString() ?? "—"} views</span>
        <span>·</span>
        <span>{reel.source}</span>
        {stage === "scraped" && (
          <span
            className={`badge ${
              reel.transcript_status === "success"
                ? "green"
                : reel.transcript_status === "failed"
                ? "red"
                : ""
            }`}
          >
            {reel.transcript_status}
          </span>
        )}
        {(stage === "adaptation" || stage === "audio" || stage === "video" || stage === "subtitled") && (
          <FlagBadge flag={reel.red_line_flag} />
        )}
        {stage === "audio" && reel.voiceover_status !== "none" && (
          <span className={`badge ${reel.voiceover_status === "failed" ? "red" : reel.voiceover_status === "success" ? "green" : "amber"}`}>
            voiceover {reel.voiceover_status}
          </span>
        )}
        {stage === "video" && (
          <span className={`badge ${reel.source_video_path ? "green" : ""}`}>
            {reel.source_video_path ? "video uploaded" : "awaiting upload"}
          </span>
        )}
        {stage === "video" && reel.captions_status === "processing" && (
          <span className="badge amber">burning…</span>
        )}
        {stage === "video" && reel.captions_status === "failed" && (
          <span className="badge red">burn failed</span>
        )}
      </div>
      {excerpt && <div className={styles.cardExcerpt}>{excerpt}</div>}
      {stage === "scraped" && (onAccept || onReject) && (
        <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
          <button onClick={onAccept} disabled={busy}>
            Accept
          </button>
          <button className="danger" onClick={onReject} disabled={busy}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
