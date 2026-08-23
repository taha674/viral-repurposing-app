"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";

// Column 5 (Video). Two explicit steps, matching the source-of-truth
// signal (source_video_path presence, not a separate status column — see
// lib/service.ts#saveSourceVideo): upload the HeyGen/edited export, then
// burn subtitles onto it. A successful burn advances the reel to
// "captioned" server-side, so reload() here flips this popup straight to
// SubtitledStage without closing it.
export default function VideoStage({
  reel,
  busy,
  setBusy,
  setErr,
  reload,
  onBoardChange,
}: StageProps) {
  const [file, setFile] = useState<File | null>(null);

  async function upload() {
    if (!file) return;
    setErr("");
    setBusy("upload");
    const body = new FormData();
    body.append("video", file);
    const res = await fetch(`/api/reels/${reel.id}/video`, { method: "POST", body });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Video upload failed");
      return;
    }
    setFile(null);
    await reload();
    onBoardChange();
  }

  async function burn() {
    setErr("");
    setBusy("burn");
    const res = await fetch(`/api/reels/${reel.id}/captions`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Caption burn failed");
      await reload();
      return;
    }
    await reload();
    onBoardChange();
  }

  const isBurning = reel.captions_status === "processing" || busy === "burn";

  return (
    <>
      <h2>Upload the finished video</h2>
      <p className="muted">
        The HeyGen/Adobe Express export, ready except for subtitles.
      </p>
      <div className="row" style={{ alignItems: "center" }}>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={upload} disabled={busy === "upload" || !file}>
          {busy === "upload" ? "Uploading…" : "Upload"}
        </button>
      </div>
      {reel.source_video_path && (
        <p className="ok" style={{ marginTop: 8 }}>
          Video on file: {reel.source_video_path.split("/").pop()}
        </p>
      )}

      <h2 style={{ marginTop: 16 }}>Burn subtitles</h2>
      <p className="muted">
        Renders the word-synced subtitle track onto the video and strips metadata.
      </p>
      <div className="row">
        <button onClick={burn} disabled={isBurning || !reel.source_video_path}>
          {isBurning ? "Burning…" : "Burn Captions"}
        </button>
      </div>
      {reel.captions_status === "failed" && reel.captions_error && (
        <p className="error">{reel.captions_error}</p>
      )}
    </>
  );
}
