"use client";

import { useEffect, useState } from "react";
import type { Engagement } from "@/lib/engagement";
import { currentBrand } from "../BrandSwitcher";
import styles from "../board.module.css";

// Engagement drafts below the board (ticket 13). Approve (editable text),
// drop, or mark sent after pasting it by hand. The app never sends.
export default function EngagementTray() {
  const [rows, setRows] = useState<Engagement[]>([]);
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [err, setErr] = useState("");

  const fetchRows = () =>
    fetch(`/api/engagement?brand=${currentBrand()}`)
      .then((r) => r.json())
      .then((d) => (d.engagement ?? []) as Engagement[]);
  const load = async () => setRows(await fetchRows());
  useEffect(() => {
    let alive = true;
    fetchRows().then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, []);

  async function act(id: number, action: "approve" | "drop" | "sent") {
    setErr("");
    const reason = action === "drop" ? window.prompt("Why drop it?") : null;
    if (action === "drop" && !reason) return;
    const res = await fetch(`/api/engagement/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, text: edits[id], reason }),
    });
    if (!res.ok) setErr((await res.json()).error ?? "Failed");
    await load();
  }

  const open_ = rows.filter((r) => r.status === "draft" || r.status === "approved");
  return (
    <div className={styles.tray}>
      <div className={styles.trayHeader} onClick={() => setOpen((v) => !v)}>
        <span>Engagement ({open_.length} open)</span>
        <span className="muted">{open ? "Hide" : "Show"}</span>
      </div>
      {open && (
        <div className={styles.trayBody}>
          {err && <p className="error">{err}</p>}
          {rows.length === 0 && <p className="muted">No drafts.</p>}
          {rows.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: 8 }}>
              <div className="muted">
                #{r.id} · {r.kind} on {r.platform} ·{" "}
                <a href={r.target_url} target="_blank" rel="noreferrer">
                  target
                </a>{" "}
                · <span className="badge">{r.status}</span>
              </div>
              <blockquote className="muted" style={{ margin: "6px 0" }}>
                {r.context}
              </blockquote>
              {r.status === "draft" ? (
                <textarea
                  value={edits[r.id] ?? r.draft}
                  onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
                  rows={3}
                  style={{ width: "100%" }}
                />
              ) : (
                <p>{r.approved_text ?? r.draft}</p>
              )}
              <div className="row" style={{ gap: 8 }}>
                {r.status === "draft" && <button onClick={() => act(r.id, "approve")}>Approve</button>}
                {r.status === "approved" && (
                  <button onClick={() => act(r.id, "sent")}>Mark sent</button>
                )}
                {(r.status === "draft" || r.status === "approved") && (
                  <button className="secondary" onClick={() => act(r.id, "drop")}>
                    Drop
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
