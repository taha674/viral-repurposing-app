"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReelSummary, ScanLog } from "@/lib/types";
import { STAGES } from "@/lib/stages";
import styles from "./board.module.css";
import BoardToolbar from "./components/BoardToolbar";
import BoardColumn from "./components/BoardColumn";
import Trays from "./components/Trays";
import AddReelDialog from "./components/AddReelDialog";
import StageModal from "./components/StageModal";

// Board shell: one 6-column kanban (lib/stages.ts is the single source of
// truth for which status lands in which column), two collapsible trays for
// reels that left the board on purpose (Rejected, Done), and a stage-aware
// popup opened per card. No page navigation for any of the pipeline work —
// see phase1-spec.md / the kanban revamp plan for why (keeps every human
// approval gate a single explicit click away, never a drag gesture).
export default function Board() {
  const [reels, setReels] = useState<ReelSummary[]>([]);
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/reels");
    const data = await res.json();
    setReels(data.reels ?? []);
  }, []);

  const loadScanLogs = useCallback(async () => {
    const res = await fetch("/api/scan");
    const data = await res.json();
    setScanLogs(data.logs ?? []);
  }, []);

  useEffect(() => {
    load();
    loadScanLogs();
  }, [load, loadScanLogs]);

  // Poll while anything is mid-flight (voiceover generating, captions
  // burning) so cards update themselves without a manual refresh. Stops
  // itself once nothing is in flight rather than running forever.
  const inFlight = reels.some(
    (r) => r.voiceover_status === "generating" || r.captions_status === "processing"
  );
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function accept(id: number) {
    setBusyId(id);
    await fetch(`/api/reels/${id}/accept`, { method: "POST" });
    setBusyId(null);
    await load();
  }

  async function reject(id: number) {
    setBusyId(id);
    await fetch(`/api/reels/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    setBusyId(null);
    await load();
  }

  async function restore(id: number) {
    setBusyId(id);
    await fetch(`/api/reels/${id}/restore`, { method: "POST" });
    setBusyId(null);
    await load();
  }

  const rejected = reels.filter((r) => r.status === "rejected");
  const done = reels.filter((r) => r.status === "archived");

  return (
    <div>
      <BoardToolbar
        scanLogs={scanLogs}
        onOpenAdd={() => setAddOpen(true)}
        onScanned={() => {
          load();
          loadScanLogs();
        }}
      />

      <div className={styles.board}>
        {STAGES.map((s) => (
          <BoardColumn
            key={s.id}
            title={s.title}
            blurb={s.blurb}
            stage={s.id}
            reels={reels.filter((r) => s.statuses.includes(r.status))}
            onOpen={setSelectedId}
            onAccept={s.id === "scraped" ? accept : undefined}
            onReject={s.id === "scraped" ? reject : undefined}
            busyId={busyId}
          />
        ))}
      </div>

      <Trays rejected={rejected} done={done} onRestore={restore} busyId={busyId} />

      {addOpen && (
        <AddReelDialog
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            load();
          }}
        />
      )}

      {selectedId !== null && (
        <StageModal
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onBoardChange={load}
        />
      )}
    </div>
  );
}
