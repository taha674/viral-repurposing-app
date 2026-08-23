"use client";

import { useEffect, useState } from "react";
import type { TrackedAccount } from "@/lib/types";

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<TrackedAccount[]>([]);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/accounts");
    const data = await res.json();
    setAccounts(data.accounts ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    setError("");
    setBusy(true);
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed");
      return;
    }
    setHandle("");
    load();
  }

  async function toggle(a: TrackedAccount) {
    await fetch(`/api/accounts/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: a.active === 0 }),
    });
    load();
  }

  async function remove(a: TrackedAccount) {
    if (!confirm(`Remove @${a.handle}?`)) return;
    await fetch(`/api/accounts/${a.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="narrow">
      <h1>Tracked Accounts</h1>
      <p className="muted">
        Instagram accounts swept by the weekly scan. TikTok is a later phase.
      </p>

      <div className="card">
        <div className="row">
          <input
            type="text"
            placeholder="handle or instagram.com URL"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button onClick={add} disabled={busy || !handle.trim()}>
            Add account
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Handle</th>
                <th>Status</th>
                <th>Last scanned</th>
                <th>Reels found</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a
                      href={`https://www.instagram.com/${a.handle}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      @{a.handle}
                    </a>
                  </td>
                  <td>
                    <span className={`badge ${a.active ? "green" : ""}`}>
                      {a.active ? "active" : "paused"}
                    </span>
                  </td>
                  <td className="muted">{a.last_scanned_at ?? "never"}</td>
                  <td>{a.reels_found_count}</td>
                  <td className="row">
                    <button className="secondary" onClick={() => toggle(a)}>
                      {a.active ? "Pause" : "Resume"}
                    </button>
                    <button className="danger" onClick={() => remove(a)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
