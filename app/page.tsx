"use client";

import { useEffect, useState, useCallback } from "react";
import type { Reel, Analysis, ReelStatus, ScanLog } from "@/lib/types";

const STATUS_FILTERS: (ReelStatus | "all")[] = [
  "all",
  "new",
  "transcribed",
  "adapted",
  "approved",
  "archived",
  "rejected",
];

function formatScanTime(runAt: string): string {
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) return runAt;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function flagBadge(flag: string) {
  if (flag === "rejected") return <span className="badge red">rejected</span>;
  if (flag === "needs_review")
    return <span className="badge amber">needs review</span>;
  return <span className="badge">no flag</span>;
}

function formatDateFound(dateFound: string): string {
  const d = new Date(dateFound);
  if (Number.isNaN(d.getTime())) return dateFound;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ReviewQueue() {
  const [reels, setReels] = useState<Reel[]>([]);
  const [filter, setFilter] = useState<ReelStatus | "all">("all");
  const [selected, setSelected] = useState<number | null>(null);

  const [url, setUrl] = useState("");
  const [addMsg, setAddMsg] = useState("");
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([]);

  const load = useCallback(async () => {
    const q = filter === "all" ? "" : `?status=${filter}`;
    const res = await fetch(`/api/reels${q}`);
    const data = await res.json();
    setReels(data.reels ?? []);
  }, [filter]);

  const loadScanLogs = useCallback(async () => {
    const res = await fetch("/api/scan");
    const data = await res.json();
    setScanLogs(data.logs ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadScanLogs();
  }, [loadScanLogs]);

  async function addReel(force: boolean) {
    setAddErr("");
    setAddMsg("");
    setBusy(true);
    const res = await fetch("/api/reels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, force }),
    });
    setBusy(false);
    const data = await res.json();
    if (!res.ok) {
      setAddErr(data.error ?? "Failed to add");
      return;
    }
    if (data.qualifies === false) {
      setAddMsg(data.message);
      return;
    }
    setUrl("");
    setAddMsg(data.forced ? "Added (forced below threshold)." : "Added.");
    load();
  }

  async function runScan() {
    setScanMsg("Scanning…");
    setBusy(true);
    const res = await fetch("/api/scan", { method: "POST" });
    setBusy(false);
    const data = await res.json();
    if (!res.ok) {
      setScanMsg(`Scan failed: ${data.error}`);
      return;
    }
    const s = data.summary;
    setScanMsg(
      `Scanned ${s.scannedAccounts} accounts · ${s.newReels} new reels · ${s.errors} errors.`
    );
    load();
    loadScanLogs();
  }

  return (
    <div>
      <h1>Review Queue</h1>
      <p className="muted">
        Discover reels, retrieve transcripts, run red-line-compliance
        adaptation, then approve and copy.
      </p>

      <div className="card">
        <h2>Add a reel manually</h2>
        <div className="row">
          <input
            type="text"
            placeholder="https://www.instagram.com/reel/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button onClick={() => addReel(false)} disabled={busy || !url.trim()}>
            Add
          </button>
          <button
            className="secondary"
            onClick={() => addReel(true)}
            disabled={busy || !url.trim()}
            title="Track even if under 1M views"
          >
            Force-add
          </button>
        </div>
        {addMsg && <p className="ok">{addMsg}</p>}
        {addErr && <p className="error">{addErr}</p>}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>Weekly scan</h2>
            <span className="muted">
              Sweeps active accounts for new 1M+ reels. (Scheduled cron comes
              with the Railway port.)
            </span>
          </div>
          <button onClick={runScan} disabled={busy}>
            {busy ? "Scanning…" : "Run scan now"}
          </button>
        </div>
        {scanMsg && <p className="ok">{scanMsg}</p>}
        {scanLogs.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 8, marginBottom: 4 }}>
              Last scan: {formatScanTime(scanLogs[0].run_at)}. This covers the
              scheduled weekly run too — reload the page any time to check
              whether it's happened and what it found.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Reels found</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {scanLogs.slice(0, 15).map((l) => (
                    <tr key={l.id}>
                      <td className="muted">{formatScanTime(l.run_at)}</td>
                      <td>{l.handle}</td>
                      <td>
                        <span className={`badge ${l.status === "error" ? "red" : "green"}`}>
                          {l.status}
                        </span>
                      </td>
                      <td>{l.reels_found}</td>
                      <td className="muted">{l.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted">Filter:</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as ReelStatus | "all")}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reel</th>
                <th>Views</th>
                <th>Source</th>
                <th>Found</th>
                <th>Transcript</th>
                <th>Status</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {reels.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  style={{
                    cursor: "pointer",
                    background:
                      selected === r.id ? "var(--panel-2)" : "transparent",
                  }}
                >
                  <td>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.shortcode ?? r.url.slice(0, 32)}
                    </a>
                  </td>
                  <td>{r.views?.toLocaleString() ?? "—"}</td>
                  <td className="muted">{r.source}</td>
                  <td className="muted">{formatDateFound(r.date_found)}</td>
                  <td>
                    <span
                      className={`badge ${
                        r.transcript_status === "success"
                          ? "green"
                          : r.transcript_status === "failed"
                          ? "red"
                          : ""
                      }`}
                    >
                      {r.transcript_status}
                    </span>
                  </td>
                  <td>{r.status}</td>
                  <td>{flagBadge(r.red_line_flag)}</td>
                </tr>
              ))}
              {reels.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No reels in this view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected !== null && (
        <ReelDetail id={selected} onChange={load} key={selected} />
      )}
    </div>
  );
}

function ReelDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const [reel, setReel] = useState<Reel | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [transcript, setTranscript] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [captionFile, setCaptionFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/reels/${id}`);
    const data = await res.json();
    setReel(data.reel);
    setAnalysis(data.analysis);
    setTranscript(data.reel?.transcript ?? "");
    setScript(data.reel?.adapted_script ?? "");
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!reel) return null;

  async function saveField(body: Record<string, unknown>) {
    await fetch(`/api/reels/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
    onChange();
  }

  async function retryTranscript() {
    setErr("");
    setBusy("transcript");
    const res = await fetch(`/api/reels/${id}/transcript`, { method: "POST" });
    setBusy("");
    if (!res.ok) setErr((await res.json()).error ?? "Failed");
    await load();
    onChange();
  }

  async function adapt() {
    setErr("");
    setBusy("adapt");
    const res = await fetch(`/api/reels/${id}/adapt`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Adaptation failed");
      return;
    }
    await load();
    onChange();
  }

  async function generateVoiceover() {
    setErr("");
    setBusy("voiceover");
    const res = await fetch(`/api/reels/${id}/voiceover`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Voiceover generation failed");
      await load();
      return;
    }
    await load();
    onChange();
  }

  async function revealVoiceover() {
    setErr("");
    setBusy("reveal");
    const res = await fetch(`/api/reels/${id}/reveal`, { method: "POST" });
    setBusy("");
    if (!res.ok) setErr((await res.json()).error ?? "Failed to open Finder");
  }

  async function burnCaptions() {
    if (!captionFile) return;
    setErr("");
    setBusy("captions");
    const body = new FormData();
    body.append("video", captionFile);
    const res = await fetch(`/api/reels/${id}/captions`, {
      method: "POST",
      body,
    });
    setBusy("");
    if (!res.ok) {
      setErr((await res.json()).error ?? "Caption burn failed");
      await load();
      return;
    }
    setCaptionFile(null);
    await load();
    onChange();
  }

  async function revealCaptionedVideo() {
    setErr("");
    setBusy("reveal-captions");
    const res = await fetch(`/api/reels/${id}/captions/reveal`, { method: "POST" });
    setBusy("");
    if (!res.ok) setErr((await res.json()).error ?? "Failed to open Finder");
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          Reel {reel.shortcode ?? reel.id}{" "}
          <span className="muted">
            · {reel.views?.toLocaleString() ?? "—"} views · {reel.status}
          </span>
        </h2>
        <div className="row" style={{ alignItems: "center" }}>
          {flagBadge(reel.red_line_flag)}
          {reel.status !== "archived" && reel.status !== "rejected" && (
            <button
              className="secondary"
              onClick={() => saveField({ status: "rejected" })}
              title="Take this reel out of the review queue for good"
            >
              Reject
            </button>
          )}
        </div>
      </div>

      {reel.red_line_reason && (
        <p className="muted">
          <strong>Red-line note:</strong> {reel.red_line_reason}
        </p>
      )}

      <h2 style={{ marginTop: 16 }}>Transcript</h2>
      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
      />
      <div className="row">
        <button className="secondary" onClick={() => saveField({ transcript })}>
          Save transcript
        </button>
        <button
          className="secondary"
          onClick={retryTranscript}
          disabled={busy === "transcript"}
        >
          {busy === "transcript" ? "Retrieving…" : "Re-pull from Apify"}
        </button>
        <button
          onClick={adapt}
          disabled={busy === "adapt" || !transcript.trim()}
        >
          {busy === "adapt" ? "Adapting…" : "Run adaptation"}
        </button>
      </div>
      {err && <p className="error">{err}</p>}

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

      {(reel.adapted_script || reel.status === "adapted") && (
        <>
          <h2 style={{ marginTop: 16 }}>
            Adapted script{" "}
            <span className="muted">(minimal edits — not a voice rewrite)</span>
          </h2>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="row">
            <button
              className="secondary"
              onClick={() => saveField({ adapted_script: script })}
            >
              Save edits
            </button>
            <button
              className="secondary"
              onClick={() => navigator.clipboard.writeText(script)}
            >
              Copy script
            </button>
            {reel.status !== "approved" && reel.status !== "archived" && (
              <button onClick={() => saveField({ status: "approved" })}>
                Approve
              </button>
            )}
            {reel.status === "approved" && (
              <>
                <button
                  className="secondary"
                  onClick={generateVoiceover}
                  disabled={busy === "voiceover"}
                >
                  {busy === "voiceover"
                    ? "Generating…"
                    : "Generate Voiceover"}
                </button>
                <button
                  className="secondary"
                  onClick={() => saveField({ status: "archived" })}
                >
                  Archive
                </button>
              </>
            )}
          </div>
          {reel.voiceover_status !== "none" && (
            <div className="row" style={{ alignItems: "center" }}>
              <p className={reel.voiceover_status === "failed" ? "error" : "ok"}>
                Voiceover: {reel.voiceover_status}
                {reel.voiceover_status === "success" &&
                  reel.voiceover_path &&
                  ` — saved to ${reel.voiceover_path}`}
                {reel.voiceover_status === "failed" &&
                  reel.voiceover_error &&
                  ` — ${reel.voiceover_error}`}
              </p>
              {reel.voiceover_status === "success" && (
                <>
                  <a
                    className="secondary button-like"
                    href={`/api/reels/${id}/voiceover/download`}
                    download
                  >
                    Download
                  </a>
                  <button
                    className="secondary"
                    onClick={revealVoiceover}
                    disabled={busy === "reveal"}
                    title="Local machine only — opens Finder where the app server is running."
                  >
                    {busy === "reveal" ? "Opening…" : "Reveal in Finder"}
                  </button>
                </>
              )}
            </div>
          )}

          {reel.voiceover_status === "success" && (
            <>
              <h2 style={{ marginTop: 16 }}>
                Burn captions{" "}
                <span className="muted">
                  (upload the finished HeyGen video — subtitles + metadata
                  strip happen here)
                </span>
              </h2>
              <div className="row" style={{ alignItems: "center" }}>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => setCaptionFile(e.target.files?.[0] ?? null)}
                />
                <button
                  onClick={burnCaptions}
                  disabled={busy === "captions" || !captionFile}
                >
                  {busy === "captions" ? "Burning…" : "Burn Captions"}
                </button>
              </div>
              {reel.captions_status !== "none" && (
                <div className="row" style={{ alignItems: "center" }}>
                  <p className={reel.captions_status === "failed" ? "error" : "ok"}>
                    Captions: {reel.captions_status}
                    {reel.captions_status === "success" &&
                      reel.captions_video_path &&
                      ` — saved to ${reel.captions_video_path}`}
                    {reel.captions_status === "failed" &&
                      reel.captions_error &&
                      ` — ${reel.captions_error}`}
                  </p>
                  {reel.captions_status === "success" && (
                    <>
                      <a
                        className="secondary button-like"
                        href={`/api/reels/${id}/captions/download`}
                        download
                      >
                        Download
                      </a>
                      <button
                        className="secondary"
                        onClick={revealCaptionedVideo}
                        disabled={busy === "reveal-captions"}
                        title="Local machine only — opens Finder where the app server is running."
                      >
                        {busy === "reveal-captions" ? "Opening…" : "Reveal in Finder"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
