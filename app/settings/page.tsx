"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [prompt, setPrompt] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    const res = await fetch("/api/settings/prompt");
    const data = await res.json();
    setPrompt(data.prompt ?? "");
    setIsCustom(!!data.isCustom);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function save() {
    setErr("");
    setMsg("");
    setBusy(true);
    const res = await fetch("/api/settings/prompt", {
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
    setMsg("Saved. Takes effect on the next adaptation run.");
  }

  async function reset() {
    if (!confirm("Reset to the built-in default prompt? Your edits will be discarded.")) {
      return;
    }
    setErr("");
    setMsg("");
    setBusy(true);
    const res = await fetch("/api/settings/prompt", { method: "DELETE" });
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

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted">
        Edit the system prompt driving the red-line-compliance adaptation
        step. Changes apply to the next adaptation call — nothing is
        re-adapted automatically.
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>Adaptation system prompt</h2>
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
