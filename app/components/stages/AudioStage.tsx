"use client";

import type { StageProps } from "../stageTypes";

// Column 4 (Audio). Script is read-only here — edits happen back in
// Adaptation. Generate voiceover (ElevenLabs, paid + hard-capped) is the
// explicit human action; once it succeeds, play it inline and either
// download it or send the card on to the Video stage for the HeyGen upload.
export default function AudioStage({
  reel,
  busy,
  setBusy,
  setErr,
  reload,
  onBoardChange,
}: StageProps) {
  async function generate() {
    setErr("");
    setBusy("voiceover");
    const res = await fetch(`/api/reels/${reel.id}/voiceover`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Voiceover generation failed");
    }
    await reload();
    onBoardChange();
  }

  async function sendToVideo() {
    setErr("");
    setBusy("send");
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "video" }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to send to video");
      return;
    }
    await reload();
    onBoardChange();
  }

  const isGenerating = reel.voiceover_status === "generating" || busy === "voiceover";

  return (
    <>
      <h2>Approved script</h2>
      <div className="diff-view">{reel.adapted_script}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="secondary"
          onClick={() => navigator.clipboard.writeText(reel.adapted_script ?? "")}
        >
          Copy script
        </button>
      </div>

      <h2 style={{ marginTop: 16 }}>Voiceover</h2>
      <div className="row">
        <button className="secondary" onClick={generate} disabled={isGenerating}>
          {isGenerating
            ? "Generating…"
            : reel.voiceover_status === "success"
            ? "Regenerate voiceover"
            : "Generate voiceover"}
        </button>
      </div>

      {reel.voiceover_status === "failed" && reel.voiceover_error && (
        <p className="error">{reel.voiceover_error}</p>
      )}

      {reel.voiceover_status === "success" && (
        <>
          {/* updated_at busts the cache after a regenerate — the URL is
              otherwise identical, and the <audio> element won't refetch a
              src it's already loaded, so a same-session regenerate would
              silently keep playing the previous take. */}
          <audio
            key={reel.updated_at}
            controls
            style={{ width: "100%", marginTop: 8 }}
            src={`/api/reels/${reel.id}/voiceover/stream?v=${encodeURIComponent(reel.updated_at)}`}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <a
              className="secondary button-like"
              href={`/api/reels/${reel.id}/voiceover/download?v=${encodeURIComponent(reel.updated_at)}`}
              download
            >
              Download
            </a>
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button
          onClick={sendToVideo}
          disabled={busy === "send" || reel.voiceover_status !== "success"}
          title={
            reel.voiceover_status !== "success"
              ? "Generate the voiceover before sending to Video."
              : undefined
          }
        >
          {busy === "send" ? "Sending…" : "Send to video"}
        </button>
      </div>
    </>
  );
}
