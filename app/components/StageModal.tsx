"use client";

import { useCallback, useEffect, useState } from "react";
import type { Reel, Analysis } from "@/lib/types";
import { stageOf } from "@/lib/stages";
import type { StageProps } from "./stageTypes";
import ScrapedStage from "./stages/ScrapedStage";
import ScriptStage from "./stages/ScriptStage";
import AdaptationStage from "./stages/AdaptationStage";
import AudioStage from "./stages/AudioStage";
import VideoStage from "./stages/VideoStage";
import SubtitledStage from "./stages/SubtitledStage";

// The one popup every card opens into. Shared chrome (close, title, error
// slot) lives here; each stage owns its own body and action buttons below,
// since the six stages don't share a single "advance" shape (Adaptation has
// Save-edits + Approve, Video has Upload + Burn, etc.) — see StageProps.
export default function StageModal({
  id,
  onClose,
  onBoardChange,
}: {
  id: number;
  onClose: () => void;
  onBoardChange: () => void;
}) {
  const [reel, setReel] = useState<Reel | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    const res = await fetch(`/api/reels/${id}`);
    const data = await res.json();
    setReel(data.reel);
    setAnalysis(data.analysis);
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!reel) return null;

  const stage = stageOf(reel);
  const title = reel.slug ?? reel.shortcode ?? `Reel ${reel.id}`;

  const stageProps: StageProps = {
    reel,
    analysis,
    busy,
    setBusy,
    err,
    setErr,
    reload,
    onBoardChange,
    onClose,
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            <span className="muted">
              {reel.views?.toLocaleString() ?? "—"} views ·{" "}
              <a href={reel.url} target="_blank" rel="noreferrer">
                source
              </a>
            </span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {err && <p className="error">{err}</p>}
          {stage === "scraped" && <ScrapedStage {...stageProps} />}
          {stage === "script" && <ScriptStage {...stageProps} />}
          {stage === "adaptation" && <AdaptationStage {...stageProps} />}
          {stage === "audio" && <AudioStage {...stageProps} />}
          {stage === "video" && <VideoStage {...stageProps} />}
          {stage === "subtitled" && <SubtitledStage {...stageProps} />}
          {(stage === "rejected" || stage === "done") && (
            <p className="muted">
              This reel is in a tray — restore it from the board to reopen it here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
