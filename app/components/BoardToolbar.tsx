"use client";

import { useState } from "react";
import type { ScanLog } from "@/lib/types";
import styles from "../board.module.css";

function formatScanTime(runAt: string): string {
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) return runAt;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Lifted from the old page's "Weekly scan" card + scan-log table, collapsed
// behind a toggle so it doesn't compete with the board for space. Add reel
// opens AddReelDialog (owned by the board shell, triggered from here).
export default function BoardToolbar({
  scanLogs,
  onOpenAdd,
  onScanned,
}: {
  scanLogs: ScanLog[];
  onOpenAdd: () => void;
  onScanned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [logOpen, setLogOpen] = useState(false);

  async function runScan() {
    setScanMsg("Scanning…");
    setBusy(true);
    const res = await fetch("/api/scan", { method: "POST" });
    setBusy(false);
    const data = await res.json();
    if (!res.ok) {
      setScanMsg(`Scan failed: ${data.error}`);
      return;
    }
    const s = data.summary;
    setScanMsg(
      `Scanned ${s.scannedAccounts} accounts + ${s.scannedHashtags} hashtags · ${s.newReels} new reels · ${s.errors} errors.`
    );
    onScanned();
  }

  return (
    <div className={styles.toolbar}>
      <div>
        <h1 style={{ marginBottom: 2 }}>Board</h1>
        <p className="muted" style={{ margin: 0 }}>
          Discover reels, adapt, voice, upload, and subtitle — one card per reel.
        </p>
      </div>
      <div className={styles.toolbarActions}>
        {scanMsg && <span className="muted">{scanMsg}</span>}
        {scanLogs.length > 0 && (
          <button className="secondary" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "Hide" : "Scan log"} ({formatScanTime(scanLogs[0].run_at)})
          </button>
        )}
        <button className="secondary" onClick={runScan} disabled={busy}>
          {busy ? "Scanning…" : "Run scan now"}
        </button>
        <button onClick={onOpenAdd}>+ Add reel</button>
      </div>

      {logOpen && (
        <div className="card" style={{ width: "100%", marginTop: 8 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Reels found</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {scanLogs.slice(0, 15).map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{formatScanTime(l.run_at)}</td>
                    <td>{l.handle}</td>
                    <td>
                      <span className={`badge ${l.status === "error" ? "red" : "green"}`}>
                        {l.status}
                      </span>
                    </td>
                    <td>{l.reels_found}</td>
                    <td className="muted">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
