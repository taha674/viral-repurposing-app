"use client";

import type { StageProps } from "../stageTypes";
import PublishPackPanel from "../PublishPackPanel";

// Column 6 (Subtitled). The finished, metadata-stripped file, plus the
// publish pack — this is the moment the operator is actually about to post,
// so the suggested caption/hashtags/cover hook belong here as well as back
// at Adaptation. Archive is still the only pipeline action: this project
// doesn't automate the Instagram post itself, it just hands you the pieces.
export default function SubtitledStage(props: StageProps) {
  const { reel, busy, setBusy, setErr, onBoardChange, onClose } = props;

  async function archive() {
    // Archiving deletes this reel's entire folder from the volume — the
    // finished video included (lib/retention.ts). That is the only thing
    // reclaiming disk in this pipeline, but it makes Archive irreversible,
    // so it gets a confirm naming exactly what goes.
    const ok = window.confirm(
      "Archive this reel?\n\n" +
        "This permanently deletes its files from the server — the finished " +
        "subtitled video, the uploaded source video, and the voiceover. " +
        "Download anything you still need first.\n\n" +
        "The script and publish pack are kept."
    );
    if (!ok) return;

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

      <PublishPackPanel {...props} />

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={archive} disabled={busy === "archive"}>
          {busy === "archive" ? "Archiving…" : "Archive (deletes files)"}
        </button>
      </div>
    </>
  );
}
