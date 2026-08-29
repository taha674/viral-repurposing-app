"use client";

import { useEffect, useState } from "react";
import type { TrackedAccount, TrackedHashtag } from "@/lib/types";

// Discovery Sources (2026-08-24, renamed from "Tracked Accounts"): the two
// inputs the scan (on-demand and weekly) draws from — tracked IG accounts
// (existing) and tracked hashtags (new). Same page, same lifecycle pattern
// (add / pause / remove, last scan, running found-count) for both.
export default function DiscoveryPage() {
  return (
    <div className="narrow">
      <h1>Discovery Sources</h1>
      <p className="muted">
        What the scan (on-demand and weekly) draws from. Tracked accounts are
        swept for their own recent posts; tracked hashtags are swept for
        top/recent reels matching the tag, filtered to the talking-head
        format and the view-count bar (500K+). Instagram only — TikTok is a
        later phase.
      </p>

      <AccountsSection />
      <HashtagsSection />
    </div>
  );
}

function AccountsSection() {
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
    <>
      <h2>Tracked Accounts</h2>
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
    </>
  );
}

function HashtagsSection() {
  const [hashtags, setHashtags] = useState<TrackedHashtag[]>([]);
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/hashtags");
    const data = await res.json();
    setHashtags(data.hashtags ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    setError("");
    setBusy(true);
    const res = await fetch("/api/hashtags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed");
      return;
    }
    setTag("");
    load();
  }

  async function toggle(h: TrackedHashtag) {
    await fetch(`/api/hashtags/${h.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: h.active === 0 }),
    });
    load();
  }

  async function remove(h: TrackedHashtag) {
    if (!confirm(`Remove #${h.tag}?`)) return;
    await fetch(`/api/hashtags/${h.id}`, { method: "DELETE" });
    load();
  }

  return (
    <>
      <h2>Tracked Hashtags</h2>
      <p className="muted">
        Reels are pulled from the hashtag, qualified by view count, then
        checked against the talking-head format before entering the
        shortlist — this filters out skits and other formats automatically.
      </p>
      <div className="card">
        <div className="row">
          <input
            type="text"
            placeholder="hashtag, with or without #"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button onClick={add} disabled={busy || !tag.trim()}>
            Add hashtag
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hashtag</th>
                <th>Status</th>
                <th>Last scanned</th>
                <th>Reels found</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hashtags.map((h) => (
                <tr key={h.id}>
                  <td>
                    <a
                      href={`https://www.instagram.com/explore/tags/${h.tag}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{h.tag}
                    </a>
                  </td>
                  <td>
                    <span className={`badge ${h.active ? "green" : ""}`}>
                      {h.active ? "active" : "paused"}
                    </span>
                  </td>
                  <td className="muted">{h.last_scanned_at ?? "never"}</td>
                  <td>{h.reels_found_count}</td>
                  <td className="row">
                    <button className="secondary" onClick={() => toggle(h)}>
                      {h.active ? "Pause" : "Resume"}
                    </button>
                    <button className="danger" onClick={() => remove(h)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {hashtags.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No hashtags yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
