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
    </div>
  );
}
