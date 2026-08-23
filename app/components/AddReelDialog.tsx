"use client";

import { useState } from "react";

// Modal version of the old page's "Add a reel manually" card. Same
// Add/Force-add behavior — only the presentation moved into a popup so it's
// not permanently taking up space above the board.
export default function AddReelDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function addReel(force: boolean) {
    setErr("");
    setMsg("");
    setBusy(true);
    const res = await fetch("/api/reels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, force }),
    });
    setBusy(false);
    const data = await res.json();
    if (!res.ok) {
      setErr(data.error ?? "Failed to add");
      return;
    }
    if (data.qualifies === false) {
      setMsg(data.message);
      return;
    }
    setUrl("");
    setMsg(data.forced ? "Added (forced below threshold)." : "Added.");
    onAdded();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ margin: 0 }}>Add a reel manually</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="row">
            <input
              type="text"
              placeholder="https://www.instagram.com/reel/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => addReel(false)} disabled={busy || !url.trim()}>
              Add
            </button>
            <button
              className="secondary"
              onClick={() => addReel(true)}
              disabled={busy || !url.trim()}
              title="Track even if under 1M views"
            >
              Force-add
            </button>
          </div>
          {msg && <p className="ok">{msg}</p>}
          {err && <p className="error">{err}</p>}
        </div>
      </div>
    </div>
  );
}
