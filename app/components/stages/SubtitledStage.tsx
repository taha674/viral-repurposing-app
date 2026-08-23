"use client";

import type { StageProps } from "../stageTypes";

// Column 6 (Subtitled). The finished, metadata-stripped file. Archive is
// the only action — it moves the card to the Done tray, not a further
// pipeline step (this project doesn't automate the Instagram post itself).
export default function SubtitledStage({
  reel,
  busy,
  setBusy,
  setErr,
  onBoardChange,
  onClose,
}: StageProps) {
  async function archive() {
    setErr("");
    setBusy("archive");
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to archive");
      return;
    }
    onBoardChange();
    onClose();
  }

  return (
    <>
      <h2>Finished video</h2>
      <video
        controls
        style={{ width: "100%", borderRadius: 8 }}
        src={`/api/reels/${reel.id}/captions/stream`}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <a
          className="secondary button-like"
          href={`/api/reels/${reel.id}/captions/download`}
          download
        >
          Download
        </a>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={archive} disabled={busy === "archive"}>
          {busy === "archive" ? "Archiving…" : "Archive"}
        </button>
      </div>
    </>
  );
}
