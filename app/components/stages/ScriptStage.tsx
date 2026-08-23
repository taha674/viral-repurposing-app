"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";

// Column 2 (Script). The transcript is still editable here (last chance
// before it feeds the paid Gemini adaptation call) — Run adaptation is the
// explicit, human-triggered step that advances the card into Adaptation.
export default function ScriptStage({
  reel,
  busy,
  setBusy,
  setErr,
  reload,
  onBoardChange,
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

  async function adapt() {
    setErr("");
    setBusy("adapt");
    const res = await fetch(`/api/reels/${reel.id}/adapt`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Adaptation failed");
      return;
    }
    await reload();
    onBoardChange();
  }

  return (
    <>
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
        <button onClick={adapt} disabled={busy === "adapt" || !transcript.trim()}>
          {busy === "adapt" ? "Adapting…" : "Run adaptation"}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        Runs the red-line-compliance adaptation and moves this card to Adaptation once done.
      </p>
    </>
  );
}
