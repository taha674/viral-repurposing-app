"use client";

import { useCallback, useEffect, useState } from "react";

// Two independently-overridable Gemini system prompts. They're edited in one
// place but stored under separate settings keys, so customizing the
// adaptation prompt never silently changes what the publish pack is told —
// which matters, because a saved override is sent verbatim and would not
// know about anything added to the other call's schema.
const PROMPTS = {
  adaptation: {
    label: "Adaptation",
    heading: "Adaptation system prompt",
    blurb:
      "Drives the red-line-compliance edit of the source transcript. Minimal edits, not a voice rewrite.",
    savedMsg: "Saved. Takes effect on the next adaptation run.",
  },
  publish: {
    label: "Publish pack",
    heading: "Publish pack system prompt",
    blurb:
      "Drives the suggested Instagram caption, hashtag set, and cover text hook. Everything it writes is a draft you edit and choose from — the app never posts.",
    savedMsg: "Saved. Takes effect on the next publish pack you generate.",
  },
} as const;

type PromptKey = keyof typeof PROMPTS;

type VolumeInfo = {
  formatted: string;
  thresholdMb: number;
  overThreshold: boolean;
};

// Storage panel: shows current usage on REELS_OUTPUT_DIR against the
// auto-purge threshold, and a button to run that same check on demand
// (useful right after archiving a batch, instead of waiting for the next
// write to trigger it). See lib/service.ts#autoPurgeIfOverThreshold — this
// only ever reclaims archived reels' folders and already-burned reels'
// source videos, never active or undownloaded work.
function StoragePanel() {
  const [info, setInfo] = useState<VolumeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/volume");
      const data = await res.json();
      if (res.ok) setInfo(data);
    } catch {
      // Non-critical panel — a failed fetch just leaves it blank.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function checkNow() {
    setErr("");
    setNote("");
    setBusy(true);
    const res = await fetch("/api/settings/volume", { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(data.error ?? "Purge check failed");
      return;
    }
    const r = data.result as { ranPurge: boolean; deleted: unknown[] };
    setNote(
      r.ranPurge
        ? `Freed ${data.freedFormatted} — ${r.deleted.length} item(s) removed.`
        : "Already under the threshold — nothing to do."
    );
    await load();
  }

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Storage</h2>
          {info && (
            <span className="muted">
              {info.formatted} on disk · {info.thresholdMb}MB threshold{" "}
              {info.overThreshold ? (
                <span className="badge red">over threshold</span>
              ) : (
                <span className="badge green">ok</span>
              )}
            </span>
          )}
        </div>
        <button className="secondary" onClick={checkNow} disabled={busy}>
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>
      <p className="muted">
        Past the threshold, the app automatically reclaims archived
        reels&rsquo; files and already-burned reels&rsquo; source videos
        before its next voiceover, upload, or burn. It never touches an
        active or not-yet-downloaded reel.
      </p>
      {note && <p className="ok">{note}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

type ScanLimits = {
  minNewReelsPerRun: number;
  batchPerAccount: number;
  postsPerAccount: number;
  postsPerHashtag: number;
};

type ScanInfo = {
  scheduledEnabled: boolean;
  limits: ScanLimits;
  defaults: ScanLimits;
  max: ScanLimits;
};

const SCAN_FIELDS: { key: keyof ScanLimits; label: string; hint: string }[] = [
  {
    key: "minNewReelsPerRun",
    label: "New reels per scan",
    hint: "Total cap per run. Each one costs a paid Apify transcript pull — this is the main spend lever.",
  },
  {
    key: "batchPerAccount",
    label: "Reels per account per turn",
    hint: "Accounts take turns giving up this many new reels (highest-viewed first) until the cap above is met.",
  },
  {
    key: "postsPerAccount",
    label: "Posts pulled per account",
    hint: "Metadata-only sweep of each tracked account's recent posts.",
  },
  {
    key: "postsPerHashtag",
    label: "Reels pulled per hashtag",
    hint: "Top reels fetched per tracked hashtag before filtering.",
  },
];

// Scan panel: on/off for the weekly scheduled scan (manual "Run scan now" is
// unaffected) and the limits every scan run uses. Scheduled scanning is off
// until switched on here.
function ScanPanel() {
  const [info, setInfo] = useState<ScanInfo | null>(null);
  const [draft, setDraft] = useState<Record<keyof ScanLimits, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const apply = useCallback((data: ScanInfo) => {
    setInfo(data);
    setDraft({
      minNewReelsPerRun: String(data.limits.minNewReelsPerRun),
      batchPerAccount: String(data.limits.batchPerAccount),
      postsPerAccount: String(data.limits.postsPerAccount),
      postsPerHashtag: String(data.limits.postsPerHashtag),
    });
  }, []);

  useEffect(() => {
    fetch("/api/settings/scan")
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  }, [apply]);

  async function send(method: "PUT" | "DELETE", body?: unknown, okMsg = "Saved.") {
    setErr("");
    setNote("");
    setBusy(true);
    const res = await fetch("/api/settings/scan", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(data.error ?? "Failed to save");
      return;
    }
    apply(data);
    setNote(okMsg);
  }

  if (!info || !draft) return null;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Scan</h2>
          <span className="muted">
            Weekly scheduled scan{" "}
            {info.scheduledEnabled ? (
              <span className="badge amber">on</span>
            ) : (
              <span className="badge">off</span>
            )}
          </span>
        </div>
        <button
          className={info.scheduledEnabled ? "secondary" : ""}
          disabled={busy}
          onClick={() =>
            send(
              "PUT",
              { scheduledEnabled: !info.scheduledEnabled },
              info.scheduledEnabled
                ? "Scheduled scan turned off."
                : "Scheduled scan turned on — next run is Monday."
            )
          }
        >
          {info.scheduledEnabled ? "Turn off" : "Turn on"}
        </button>
      </div>
      <p className="muted">
        Off skips the Monday run entirely (no Apify calls). &ldquo;Run scan
        now&rdquo; still works. The limits below apply to every scan, scheduled
        or manual.
      </p>

      {SCAN_FIELDS.map((f) => (
        <div key={f.key} style={{ marginBottom: 10 }}>
          <label style={{ display: "block", fontWeight: 600 }}>
            {f.label}{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              (default {info.defaults[f.key]}, max {info.max[f.key]})
            </span>
          </label>
          <input
            type="number"
            min={1}
            max={info.max[f.key]}
            value={draft[f.key]}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            style={{ width: 120 }}
          />
          <div className="muted">{f.hint}</div>
        </div>
      ))}

      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            send(
              "PUT",
              {
                limits: Object.fromEntries(
                  SCAN_FIELDS.map((f) => [f.key, Number(draft[f.key])])
                ),
              },
              "Saved. Applies to the next scan."
            )
          }
        >
          Save limits
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => send("DELETE", undefined, "Reset to defaults.")}
        >
          Reset to defaults
        </button>
      </div>
      {note && <p className="ok">{note}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export default function SettingsPage() {
  const [which, setWhich] = useState<PromptKey>("adaptation");
  const [prompt, setPrompt] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async (key: PromptKey) => {
    setLoading(true);
    const res = await fetch(`/api/settings/prompt?which=${key}`);
    const data = await res.json();
    setPrompt(data.prompt ?? "");
    setIsCustom(!!data.isCustom);
    setLoading(false);
  }, []);

  // Refetches on every tab switch — the two prompts are separate rows, and
  // showing a stale one would risk saving the wrong text under the wrong key.
  // Clearing the save/error message is done in the tab handler instead, so
  // this effect only does the one thing it exists for.
  useEffect(() => {
    load(which);
  }, [which, load]);

  async function save() {
    setErr("");
    setMsg("");
    setBusy(true);
    const res = await fetch(`/api/settings/prompt?which=${which}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(data.error ?? "Failed to save prompt");
      return;
    }
    setPrompt(data.prompt);
    setIsCustom(data.isCustom);
    setMsg(PROMPTS[which].savedMsg);
  }

  async function reset() {
    if (!confirm("Reset to the built-in default prompt? Your edits will be discarded.")) {
      return;
    }
    setErr("");
    setMsg("");
    setBusy(true);
    const res = await fetch(`/api/settings/prompt?which=${which}`, {
      method: "DELETE",
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(data.error ?? "Failed to reset prompt");
      return;
    }
    setPrompt(data.prompt);
    setIsCustom(data.isCustom);
    setMsg("Reset to default.");
  }

  const current = PROMPTS[which];

  return (
    <div className="narrow">
      <h1>Settings</h1>
      <p className="muted">
        Edit the system prompts driving the Gemini calls. Changes apply to the
        next call of that kind — nothing is re-run automatically.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        {(Object.keys(PROMPTS) as PromptKey[]).map((key) => (
          <button
            key={key}
            className={key === which ? "" : "secondary"}
            onClick={() => {
              setMsg("");
              setErr("");
              setWhich(key);
            }}
            disabled={busy}
          >
            {PROMPTS[key].label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>{current.heading}</h2>
            <span className="muted">
              {isCustom ? (
                <span className="badge amber">customized</span>
              ) : (
                <span className="badge">default</span>
              )}
            </span>
          </div>
          <div className="row">
            <button
              className="secondary"
              onClick={reset}
              disabled={busy || loading || !isCustom}
            >
              Reset to default
            </button>
            <button onClick={save} disabled={busy || loading || !prompt.trim()}>
              Save
            </button>
          </div>
        </div>

        <p className="muted">{current.blurb}</p>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <textarea
            style={{ minHeight: 420, fontFamily: "monospace", fontSize: 13 }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        )}

        {msg && <p className="ok">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      <ScanPanel />

      <StoragePanel />
    </div>
  );
}
