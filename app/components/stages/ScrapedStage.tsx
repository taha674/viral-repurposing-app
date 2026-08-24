"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";

// Column 1 (Scraped). Editing box = transcript, same as the pre-board UI's
// "Retrieve transcript" step. Accept moves the card into Script (mints its
// slug server-side); Reject sends it to the Rejected tray. Both are the
// human-decision gate between "discovered" and "worth working on".
export default function ScrapedStage({
  reel,
  busy,
  setBusy,
  setErr,
  reload,
  onBoardChange,
  onClose,
}: StageProps) {
  const [transcript, setTranscript] = useState(reel.transcript ?? "");

  async function saveTranscript() {
    setErr("");
    setBusy("save");
    await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    setBusy("");
    await reload();
    onBoardChange();
  }

  async function retryTranscript() {
    setErr("");
    setBusy("transcript");
    const res = await fetch(`/api/reels/${reel.id}/transcript`, { method: "POST" });
    setBusy("");
    if (!res.ok) setErr((await res.json()).error ?? "Failed");
    await reload();
    onBoardChange();
  }

  async function accept() {
    setErr("");
    setBusy("accept");
    const res = await fetch(`/api/reels/${reel.id}/accept`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to accept");
      return;
    }
    onBoardChange();
    onClose();
  }

  async function reject() {
    setErr("");
    setBusy("reject");
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to reject");
      return;
    }
    onBoardChange();
    onClose();
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">
          {reel.views?.toLocaleString() ?? "—"} views · {reel.source} ·{" "}
          <span
            className={`badge ${
              reel.transcript_status === "success"
                ? "green"
                : reel.transcript_status === "failed"
                ? "red"
                : ""
            }`}
          >
            transcript {reel.transcript_status}
          </span>
        </span>
      </div>

      <h2>Transcript</h2>
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} />
      <div className="row">
        <button className="secondary" onClick={saveTranscript} disabled={busy === "save"}>
          {busy === "save" ? "Saving…" : "Save transcript"}
        </button>
        <button
          className="secondary"
          onClick={retryTranscript}
          disabled={busy === "transcript"}
        >
          {busy === "transcript" ? "Retrieving…" : "Re-pull from Apify"}
        </button>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={accept} disabled={busy === "accept" || !transcript.trim()}>
          {busy === "accept" ? "Accepting…" : "Accept"}
        </button>
        <button className="danger" onClick={reject} disabled={busy === "reject"}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </>
  );
}
