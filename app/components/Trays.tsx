"use client";

import { useState } from "react";
import type { ReelSummary } from "@/lib/types";
import styles from "../board.module.css";

function Tray({
  title,
  reels,
  onRestore,
  busyId,
}: {
  title: string;
  reels: ReelSummary[];
  onRestore: (id: number) => void;
  busyId: number | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.tray}>
      <div className={styles.trayHeader} onClick={() => setOpen((v) => !v)}>
        <span>
          {title} ({reels.length})
        </span>
        <span className="muted">{open ? "Hide" : "Show"}</span>
      </div>
      {open && (
        <div className={styles.trayBody}>
          {reels.length === 0 && <p className="muted">Empty.</p>}
          {reels.map((r) => (
            <div key={r.id} className={styles.trayRow}>
              <span>{r.slug ?? r.shortcode ?? r.url.slice(0, 40)}</span>
              <button
                className="secondary"
                onClick={() => onRestore(r.id)}
                disabled={busyId === r.id}
              >
                {busyId === r.id ? "Restoring…" : "Restore to board"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Two collapsible drawers below the board: reels that fell off the pipeline
// on purpose. Rejected only ever happens from Scraped, Archive only ever
// happens from Subtitled (see lib/service.ts#restoreReel's comment) — so
// restoring always lands the card back in the right column with no extra
// input needed.
export default function Trays({
  rejected,
  done,
  onRestore,
  busyId,
}: {
  rejected: ReelSummary[];
  done: ReelSummary[];
  onRestore: (id: number) => void;
  busyId: number | null;
}) {
  return (
    <div className={styles.trays}>
      <Tray title="Rejected" reels={rejected} onRestore={onRestore} busyId={busyId} />
      <Tray title="Done" reels={done} onRestore={onRestore} busyId={busyId} />
    </div>
  );
}
