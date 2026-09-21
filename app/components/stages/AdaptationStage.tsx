"use client";

import { useState } from "react";
import type { StageProps } from "../stageTypes";
import { FlagBadge } from "../Badges";
import DiffView from "../DiffView";
import PublishPackPanel from "../PublishPackPanel";

// Column 3 (Adaptation). Diff-first: the color-coded transcript -> adapted
// script diff is the primary view, with an Edit toggle for hand-tweaking
// before Approve — same edit capability the pre-board UI had, just not
// shown by default since the diff is what needs reviewing.
export default function AdaptationStage(props: StageProps) {
  // Kept as one object as well as destructured fields: PublishPackPanel
  // takes the same StageProps contract, so it gets the whole thing.
  const { reel, analysis, busy, setBusy, setErr, reload, onBoardChange, onClose } =
    props;
  const [editing, setEditing] = useState(false);
  const [script, setScript] = useState(reel.adapted_script ?? "");

  async function saveScript(text: string) {
    await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapted_script: text }),
    });
  }

  async function saveEdits() {
    setErr("");
    setBusy("save");
    await saveScript(script);
    setBusy("");
    await reload();
    onBoardChange();
    setEditing(false);
  }

  async function approve() {
    setErr("");
    setBusy("approve");
    // If the operator is mid-edit, the textarea's contents only live in
    // local state until "Save edits" is clicked — approving without
    // flushing them first would silently approve (and later voice) the
    // pre-edit script instead of what's on screen.
    if (editing) {
      await saveScript(script);
    }
    const res = await fetch(`/api/reels/${reel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Failed to approve");
      return;
    }
    setEditing(false);
    onBoardChange();
    onClose();
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <FlagBadge flag={reel.red_line_flag} />
        <button className="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? "View diff" : "Edit script"}
        </button>
      </div>

      {reel.red_line_reason && (
        <p className="muted">
          <strong>Red-line note:</strong> {reel.red_line_reason}
        </p>
      )}

      <h2 style={{ marginTop: 12 }}>
        Adapted script <span className="muted">(minimal edits — not a voice rewrite)</span>
      </h2>
      {editing ? (
        <>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} />
          <div className="row">
            <button className="secondary" onClick={saveEdits} disabled={busy === "save"}>
              {busy === "save" ? "Saving…" : "Save edits"}
            </button>
          </div>
        </>
      ) : (
        <DiffView before={reel.transcript ?? ""} after={reel.adapted_script ?? ""} />
      )}

      {analysis && (
        <>
          <h2 style={{ marginTop: 16 }}>Source breakdown</h2>
          <table>
            <tbody>
              <tr>
                <th>Hook</th>
                <td>{analysis.hook}</td>
              </tr>
              <tr>
                <th>Reframe</th>
                <td>{analysis.reframe}</td>
              </tr>
              <tr>
                <th>Mechanism</th>
                <td>{analysis.mechanism}</td>
              </tr>
              <tr>
                <th>Philosophical close</th>
                <td>{analysis.philosophical_close}</td>
              </tr>
              <tr>
                <th>CTA</th>
                <td>{analysis.cta}</td>
              </tr>
              <tr>
                <th>Top triggers</th>
                <td>{analysis.top_psychological_triggers?.join(", ")}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button
          onClick={approve}
          disabled={busy === "approve" || !reel.adapted_script?.trim()}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          className="secondary"
          onClick={() => navigator.clipboard.writeText(reel.adapted_script ?? "")}
        >
          Copy script
        </button>
      </div>

      <PublishPackPanel {...props} />
    </>
  );
}
