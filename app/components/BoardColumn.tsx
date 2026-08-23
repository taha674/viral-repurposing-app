"use client";

import type { ReelSummary } from "@/lib/types";
import type { Stage } from "@/lib/stages";
import ReelCard from "./ReelCard";
import styles from "../board.module.css";

export default function BoardColumn({
  title,
  blurb,
  stage,
  reels,
  onOpen,
  onAccept,
  onReject,
  busyId,
  headerExtra,
}: {
  title: string;
  blurb: string;
  stage: Stage;
  reels: ReelSummary[];
  onOpen: (id: number) => void;
  onAccept?: (id: number) => void;
  onReject?: (id: number) => void;
  busyId: number | null;
  headerExtra?: React.ReactNode;
}) {
  return (
    <div className={styles.column}>
      <div className={styles.columnHeader}>
        <div className={styles.columnTitle}>
          <span>
            {title} <span className={styles.columnCount}>({reels.length})</span>
          </span>
          {headerExtra}
        </div>
        <div className={styles.columnBlurb}>{blurb}</div>
      </div>
      <div className={styles.columnBody}>
        {reels.length === 0 && <p className={styles.empty}>Nothing here.</p>}
        {reels.map((r) => (
          <ReelCard
            key={r.id}
            reel={r}
            stage={stage}
            onOpen={() => onOpen(r.id)}
            onAccept={onAccept ? () => onAccept(r.id) : undefined}
            onReject={onReject ? () => onReject(r.id) : undefined}
            busy={busyId === r.id}
          />
        ))}
      </div>
    </div>
  );
}
