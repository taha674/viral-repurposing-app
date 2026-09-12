"use client";

import { useState } from "react";
import type { StageProps } from "./stageTypes";
import { FlagBadge } from "./Badges";
import type { HookMode, PublishPack } from "@/lib/types";

// Suggested post metadata: the Instagram caption, the hashtag set, and the
// text hook for the cover frame. Shown in BOTH the Adaptation stage (where
// the script is being reviewed, so the caption can be reviewed alongside it)
// and the Subtitled stage (where the operator is actually about to post).
//
// Everything here is a draft. The app never posts, never commits to a final
// tag list, and never touches the platform's AI-content toggle — see the
// caption/hashtag rule in CLAUDE.md. Hence: copy buttons and an edit mode,
// no "publish" anything.

const HOOK_MODE_LABELS: Record<HookMode, string> = {
  subtitle_only: "Subtitle frame only",
  sticker_only: "Text sticker only",
  subtitle_plus_sticker: "Subtitle frame + text sticker",
};

// mm:ss.s — the format you'd scrub to in Instagram's cover picker.
function formatSeconds(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = s - mins * 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

export default function PublishPackPanel({
  reel,
  busy,
  setBusy,
  setErr,
  reload,
}: StageProps) {
  const pack = reel.publish_pack;
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(pack?.caption ?? "");
  const [tags, setTags] = useState((pack?.hashtags ?? []).join(" "));

  async function generate() {
    setErr("");
    setBusy("pack");
    const res = await fetch(`/api/reels/${reel.id}/publish-pack`, {
      method: "POST",
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to generate publish pack");
      return;
    }
    const { reel: updated } = await res.json();
    // Reseed the edit buffers from what actually came back, so toggling into
    // Edit after a regenerate doesn't show the previous pack's text.
    setCaption(updated?.publish_pack?.caption ?? "");
    setTags((updated?.publish_pack?.hashtags ?? []).join(" "));
    setEditing(false);
    await reload();
  }

  async function saveEdits() {
    if (!pack) return;
    setErr("");
    setBusy("pack-save");
    // Saved as the whole pack: a partial write would leave the rationale
    // describing a caption that no longer exists.
    const next: PublishPack = {
      ...pack,
      caption,
      hashtags: tags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#+/, "").trim())
        .filter(Boolean),
    };
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publish_pack: next }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to save publish pack");
      return;
    }
    setEditing(false);
    await reload();
  }

  const generating = busy === "pack";
  const tagLine = (pack?.hashtags ?? []).map((t) => `#${t}`).join(" ");

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid #2a2a2a", paddingTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          Publish pack{" "}
          <span className="muted">(suggestions — you edit and choose)</span>
        </h2>
        <div className="row">
          {pack && !editing && (
            <button className="secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button
            className="secondary"
            onClick={generate}
            disabled={generating || !reel.adapted_script?.trim()}
          >
            {generating ? "Writing…" : pack ? "Regenerate" : "Generate"}
          </button>
        </div>
      </div>

      {!reel.adapted_script?.trim() && (
        <p className="muted">Run the adaptation first — the pack is written from the adapted script.</p>
      )}

      {reel.publish_pack_status === "failed" && reel.publish_pack_error && (
        <p className="error">{reel.publish_pack_error}</p>
      )}

      {!pack && reel.publish_pack_status !== "failed" && reel.adapted_script?.trim() && (
        <p className="muted">
          No pack yet. Generating uses one Gemini call and always reads the
          current adapted script, so regenerate after editing it.
        </p>
      )}

      {pack && (
        <>
          <div className="row" style={{ marginTop: 8 }}>
            <FlagBadge flag={pack.red_line_flag} />
          </div>
          {pack.red_line_reason && (
            <p className="muted">
              <strong>Red-line note:</strong> {pack.red_line_reason}
            </p>
          )}

          <h2 style={{ marginTop: 16 }}>Caption</h2>
          {editing ? (
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              style={{ minHeight: 160 }}
            />
          ) : (
            <p style={{ whiteSpace: "pre-wrap" }}>{pack.caption}</p>
          )}
          {!editing && pack.caption_rationale && (
            <p className="muted">
              <strong>Why:</strong> {pack.caption_rationale}
            </p>
          )}

          <h2 style={{ marginTop: 16 }}>Hashtags</h2>
          {editing ? (
            <textarea
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              style={{ minHeight: 80 }}
            />
          ) : (
            <p style={{ whiteSpace: "pre-wrap" }}>{tagLine || "—"}</p>
          )}
          {!editing && pack.hashtags_rejected?.length > 0 && (
            <p className="muted">
              <strong>Dropped from the source:</strong>{" "}
              {pack.hashtags_rejected.join("; ")}
            </p>
          )}

          <h2 style={{ marginTop: 16 }}>
            Text hook <span className="muted">— {HOOK_MODE_LABELS[pack.hook_mode]}</span>
          </h2>
          {pack.hook_mode_reason && <p className="muted">{pack.hook_mode_reason}</p>}
          {pack.cover_frame_seconds !== null && (
            <p>
              <strong>Cover frame:</strong> scrub to{" "}
              {formatSeconds(pack.cover_frame_seconds)} — the frame reading{" "}
              <em>&ldquo;{pack.cover_frame_line}&rdquo;</em>
            </p>
          )}

          {pack.hook_mode !== "subtitle_only" && pack.thumbnail_text?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sticker text</th>
                    <th>Technique</th>
                    <th>How the video pays it off</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pack.thumbnail_text.map((o, i) => (
                    <tr key={i}>
                      <td>
                        <strong>{o.text}</strong>
                      </td>
                      <td className="muted">{o.technique}</td>
                      <td className="muted">{o.why_not_clickbait}</td>
                      <td>
                        <button
                          className="secondary"
                          onClick={() => navigator.clipboard.writeText(o.text)}
                        >
                          Copy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {editing ? (
              <>
                <button onClick={saveEdits} disabled={busy === "pack-save"}>
                  {busy === "pack-save" ? "Saving…" : "Save edits"}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setCaption(pack.caption);
                    setTags(pack.hashtags.join(" "));
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="secondary"
                  onClick={() => navigator.clipboard.writeText(pack.caption)}
                >
                  Copy caption
                </button>
                <button
                  className="secondary"
                  onClick={() => navigator.clipboard.writeText(tagLine)}
                  disabled={!tagLine}
                >
                  Copy hashtags
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      tagLine ? `${pack.caption}\n\n${tagLine}` : pack.caption
                    )
                  }
                >
                  Copy both
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
