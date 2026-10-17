"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";
import PublishPackPanel from "../PublishPackPanel";

// Column 6 (Subtitled). The finished, metadata-stripped file, plus the
// publish pack — this is the moment the operator is actually about to post,
// so the suggested caption/hashtags/cover hook belong here as well as back
// at Adaptation. Also renders the Scheduled and Posted columns: Schedule and
// Mark posted only record what the operator plans and does (this project
// never posts), and Archive deletes the files.
export default function SubtitledStage(props: StageProps) {
  const { reel, busy, setBusy, setErr, onBoardChange, onClose, reload } = props;
  const [plannedAt, setPlannedAt] = useState(
    reel.planned_post_at ? toLocalInput(reel.planned_post_at) : ""
  );
  const [postedUrl, setPostedUrl] = useState(reel.posted_url ?? "");

  // Schedule / posted are bookkeeping: the operator publishes by hand.
  async function save(field: "planned_post_at" | "posted_url", value: string) {
    setErr("");
    setBusy(field);
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        [field]: field === "planned_post_at" ? new Date(value).toISOString() : value,
      }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to save");
      return;
    }
    await reload();
    onBoardChange();
  }

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
      {/* updated_at busts the cache after a re-burn — same reasoning as the
          voiceover <audio> tag in AudioStage. */}
      <video
        key={reel.updated_at}
        controls
        style={{ width: "100%", borderRadius: 8 }}
        src={`/api/reels/${reel.id}/captions/stream?v=${encodeURIComponent(reel.updated_at)}`}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <a
          className="secondary button-like"
          href={`/api/reels/${reel.id}/captions/download?v=${encodeURIComponent(reel.updated_at)}`}
          download
        >
          Download
        </a>
      </div>

      <PublishPackPanel {...props} />

      {reel.status !== "posted" ? (
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
          <input
            type="datetime-local"
            value={plannedAt}
            onChange={(e) => setPlannedAt(e.target.value)}
            aria-label="Planned post time"
          />
          <button
            className="secondary"
            onClick={() => save("planned_post_at", plannedAt)}
            disabled={!plannedAt || busy === "planned_post_at"}
          >
            {reel.status === "scheduled" ? "Reschedule" : "Schedule"}
          </button>
          <input
            type="url"
            placeholder="https://www.instagram.com/reel/…"
            value={postedUrl}
            onChange={(e) => setPostedUrl(e.target.value)}
            aria-label="Live post URL"
          />
          <button
            className="secondary"
            onClick={() => save("posted_url", postedUrl)}
            disabled={!postedUrl.trim() || busy === "posted_url"}
          >
            Mark posted
          </button>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>
          Posted:{" "}
          <a href={reel.posted_url ?? undefined} target="_blank" rel="noreferrer">
            {reel.posted_url}
          </a>
        </p>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={archive} disabled={busy === "archive"}>
          {busy === "archive" ? "Archiving…" : "Archive (deletes files)"}
        </button>
      </div>
    </>
  );
}

// ISO -> the "YYYY-MM-DDTHH:mm" local-time string a datetime-local input wants.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
