"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";
import { POST_PLATFORMS, PLATFORM_LABELS, type PostPlatform } from "@/lib/types";
import PublishPackPanel from "../PublishPackPanel";

// Finished column (and Pending approval, Scheduled, Posted). For a reel: the
// finished, metadata-stripped file, plus the
// publish pack — this is the moment the operator is actually about to post,
// so the suggested caption/hashtags/cover hook belong here as well as back
// at Adaptation. Also renders the Scheduled and Posted columns: Schedule and
// Mark posted only record what the operator plans and does (this project
// never posts), and Archive deletes the files. A story shows its image or
// video and a text post its body; both get an Approve button while pending
// (the operator approving here is the human gate, no quote needed).
export default function SubtitledStage(props: StageProps) {
  const { reel, busy, setBusy, setErr, onBoardChange, onClose, reload } = props;
  const [plannedAt, setPlannedAt] = useState(
    reel.planned_post_at ? toLocalInput(reel.planned_post_at) : ""
  );
  const [platform, setPlatform] = useState<PostPlatform>("instagram");
  const [postedUrl, setPostedUrl] = useState("");

  // Schedule / posted are bookkeeping: the operator publishes by hand.
  async function save(field: "planned_post_at" | "post_link" | "approve" | "sent") {
    setErr("");
    setBusy(field);
    const body =
      field === "planned_post_at"
        ? { planned_post_at: new Date(plannedAt).toISOString() }
        : field === "post_link"
        ? { post_link: { platform, url: postedUrl } }
        : field === "approve"
        ? { status: "captioned" }
        : { mark_posted_without_link: true };
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to save");
      return;
    }
    if (field === "post_link") setPostedUrl("");
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

  const pending = reel.status === "pending_approval";
  const fileUrl = `/api/reels/${reel.id}/captions/stream?v=${encodeURIComponent(reel.updated_at)}`;
  const isImage = /\.(png|jpe?g|webp)$/i.test(reel.captions_video_path ?? "");

  if (reel.kind === "text") {
    return (
      <>
        <h2>Text post · {reel.text_channel?.replace("_", " ")}</h2>
        <pre style={{ whiteSpace: "pre-wrap" }}>{reel.adapted_script}</pre>
        {pending && (
          <button onClick={() => save("approve")} disabled={busy === "approve"}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        )}
        {reel.text_channel === "email" && (reel.status === "captioned" || reel.status === "scheduled") && (
          <button className="secondary" onClick={() => save("sent")} disabled={busy === "sent"}>
            Mark sent (no link)
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <h2>{reel.kind === "story" ? "Story" : reel.kind === "carousel" ? "Carousel slides" : "Finished video"}</h2>
      {reel.kind === "story" && <p className="muted">{reel.transcript}</p>}
      {reel.kind === "carousel" ? (
        <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
          {(reel.slide_paths ?? []).map((_, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={`/api/reels/${reel.id}/slides/${i}?v=${encodeURIComponent(reel.updated_at)}`} alt={`Slide ${i + 1}`} style={{ height: 240, borderRadius: 6 }} />
          ))}
        </div>
      ) : reel.captions_status !== "success" ? (
        <p className="muted">No file uploaded yet.</p>
      ) : isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl} alt="" style={{ width: "100%", borderRadius: 8 }} />
      ) : (
        // updated_at busts the cache after a re-burn — same reasoning as the
        // voiceover <audio> tag in AudioStage.
        <video key={reel.updated_at} controls style={{ width: "100%", borderRadius: 8 }} src={fileUrl} />
      )}
      {pending && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => save("approve")} disabled={busy === "approve" || reel.captions_status !== "success"}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
      {!pending && (
      <>
      <div className="row" style={{ marginTop: 8 }}>
        <a
          className="secondary button-like"
          href={`/api/reels/${reel.id}/captions/download?v=${encodeURIComponent(reel.updated_at)}`}
          download
        >
          Download
        </a>
      </div>

      {reel.kind !== "story" && <PublishPackPanel {...props} />}

      {reel.status !== "posted" && (
        <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
          <input
            type="datetime-local"
            value={plannedAt}
            onChange={(e) => setPlannedAt(e.target.value)}
            aria-label="Planned post time"
          />
          <button
            className="secondary"
            onClick={() => save("planned_post_at")}
            disabled={!plannedAt || busy === "planned_post_at"}
          >
            {reel.status === "scheduled" ? "Reschedule" : "Schedule"}
          </button>
        </div>
      )}

      {reel.post_links.length > 0 && (
        <ul className="muted" style={{ marginTop: 16 }}>
          {reel.post_links.map((l) => (
            <li key={l.platform}>
              {PLATFORM_LABELS[l.platform]}:{" "}
              <a href={l.url} target="_blank" rel="noreferrer">
                {l.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as PostPlatform)}
          aria-label="Platform"
        >
          {POST_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
        <input
          type="url"
          placeholder="https://… link to the live post"
          value={postedUrl}
          onChange={(e) => setPostedUrl(e.target.value)}
          aria-label="Live post URL"
        />
        <button
          className="secondary"
          onClick={() => save("post_link")}
          disabled={!postedUrl.trim() || busy === "post_link"}
        >
          {reel.status === "posted" ? "Add link" : "Mark posted"}
        </button>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={archive} disabled={busy === "archive"}>
          {busy === "archive" ? "Archiving…" : "Archive (deletes files)"}
        </button>
      </div>
      </>
      )}
    </>
  );
}

// ISO -> the "YYYY-MM-DDTHH:mm" local-time string a datetime-local input wants.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
