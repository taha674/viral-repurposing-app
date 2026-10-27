"use client";

import { useEffect, useState } from "react";
import type { StageProps } from "../stageTypes";

// Ticks once a second for as long as `since` is set, so a long-running
// upload/burn shows elapsed time instead of a static "Uploading…"/"Burning…"
// that looks identical whether it's been 2 seconds or 2 minutes — the exact
// ambiguity that made a slow-but-working request look broken (2026-09-16).
function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since == null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

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
  const [uploadStartedAt, setUploadStartedAt] = useState<number | null>(null);
  const [burnClickedAt, setBurnClickedAt] = useState<number | null>(null);

  // A failed request here can arrive as something other than JSON — a
  // platform-level timeout or proxy error page, not our route handler's own
  // { error } body. Parsing that with res.json() throws, and an uncaught
  // throw inside these handlers used to leave the user with no banner and a
  // stale popup: the fetch failed, but nothing ever ran to say so or to
  // reload() and pick up whatever the server-side job actually did.
  async function safeErrorMessage(res: Response, fallback: string): Promise<string> {
    try {
      const body = await res.json();
      return body?.error ?? fallback;
    } catch {
      return `${fallback} (server returned ${res.status}).`;
    }
  }

  async function upload() {
    if (!file) return;
    setErr("");
    setBusy("upload");
    setUploadStartedAt(Date.now());
    try {
      const body = new FormData();
      body.append("video", file);
      const res = await fetch(`/api/reels/${reel.id}/video`, { method: "POST", body });
      if (!res.ok) {
        setErr(await safeErrorMessage(res, "Video upload failed"));
        return;
      }
      setFile(null);
      onBoardChange();
    } catch (err) {
      setErr(err instanceof Error ? err.message : "Video upload failed");
    } finally {
      setBusy("");
      setUploadStartedAt(null);
      await reload();
    }
  }

  async function burn() {
    setErr("");
    setBusy("burn");
    setBurnClickedAt(Date.now());
    try {
      const res = await fetch(`/api/reels/${reel.id}/captions`, { method: "POST" });
      if (!res.ok) {
        setErr(await safeErrorMessage(res, "Caption burn failed"));
        return;
      }
      onBoardChange();
    } catch (err) {
      setErr(err instanceof Error ? err.message : "Caption burn failed");
    } finally {
      setBusy("");
      setBurnClickedAt(null);
      await reload();
    }
  }

  const isBurning = reel.captions_status === "processing" || busy === "burn";
  const uploadElapsed = useElapsedSeconds(busy === "upload" ? uploadStartedAt : null);
  // Prefer this click's own timestamp; fall back to the reel's updated_at
  // (touched the instant the server flips captions_status to "processing")
  // so a burn started before a page reload — or from a different tab —
  // still shows a real elapsed time instead of resetting to 0s.
  const burnStartedAt =
    busy === "burn"
      ? burnClickedAt
      : reel.captions_status === "processing"
        ? Date.parse(reel.updated_at)
        : null;
  const burnElapsed = useElapsedSeconds(burnStartedAt);

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
        <button className="secondary" onClick={upload} disabled={busy === "upload" || !file}>
          {busy === "upload" ? `Uploading… (${formatElapsed(uploadElapsed)})` : "Upload"}
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
          {isBurning ? `Burning… (${formatElapsed(burnElapsed)})` : "Burn Captions"}
        </button>
      </div>
      {reel.captions_status === "failed" && reel.captions_error && (
        <p className="error">{reel.captions_error}</p>
      )}
    </>
  );
}
