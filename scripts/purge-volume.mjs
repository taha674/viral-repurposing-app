#!/usr/bin/env node
// One-off volume cleanup — the immediate unblock for the ENOSPC that the
// retention policy in lib/retention.ts prevents going forward.
//
// Nothing in the app deleted reel media before 2026-09-12, so REELS_OUTPUT_DIR
// holds a folder for every reel ever processed, including ones archived months
// ago. This script finds the reclaimable ones and reports them.
//
// DRY RUN BY DEFAULT — it prints what it would delete and exits. Pass --delete
// to actually remove anything. Run it on Railway where the volume is mounted:
//
//   node scripts/purge-volume.mjs                 # report only
//   node scripts/purge-volume.mjs --delete        # archived reels' folders
//   node scripts/purge-volume.mjs --delete --orphans   # also unreferenced dirs
//
// Plain .mjs on purpose: runs under `node` in the Railway shell with no build
// step or TS loader, using `pg`, which is already a dependency.

import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const DELETE = process.argv.includes("--delete");
const INCLUDE_ORPHANS = process.argv.includes("--orphans");

const outputDir = process.env.REELS_OUTPUT_DIR?.trim();
if (!outputDir) {
  console.error(
    "REELS_OUTPUT_DIR is not set. On Railway this is the volume mount " +
      "(e.g. /data/reels). Refusing to guess."
  );
  process.exit(1);
}
if (!fs.existsSync(outputDir)) {
  console.error(`REELS_OUTPUT_DIR does not exist: ${outputDir}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — cannot tell archived reels apart.");
  process.exit(1);
}

function isLocalHost(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function dirSize(dir) {
  let bytes = 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      bytes += sub.bytes;
      count += sub.count;
    } else if (entry.isFile()) {
      try {
        bytes += fs.statSync(full).size;
        count += 1;
      } catch {
        /* raced with a delete */
      }
    }
  }
  return { bytes, count };
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalHost(process.env.DATABASE_URL)
    ? undefined
    : { rejectUnauthorized: false },
});

const { rows } = await pool.query(
  "SELECT id, slug, status FROM reels WHERE slug IS NOT NULL"
);
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const dirs = fs
  .readdirSync(outputDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const archived = [];
const orphans = [];
const active = [];

for (const name of dirs) {
  const full = path.join(outputDir, name);
  const { bytes, count } = dirSize(full);
  const reel = bySlug.get(name);
  const row = { name, full, bytes, count, reel };
  if (!reel) orphans.push(row);
  else if (reel.status === "archived") archived.push(row);
  else active.push(row);
}

const sum = (list) => list.reduce((t, r) => t + r.bytes, 0);
const byBiggest = (a, b) => b.bytes - a.bytes;

function report(title, list, note) {
  console.log(`\n${title} — ${list.length} folder(s), ${fmt(sum(list))}`);
  if (note) console.log(`  ${note}`);
  for (const r of [...list].sort(byBiggest)) {
    const who = r.reel ? `reel ${r.reel.id} (${r.reel.status})` : "no DB row";
    console.log(`  ${fmt(r.bytes).padStart(9)}  ${r.name}  [${who}, ${r.count} file(s)]`);
  }
}

console.log(`Volume: ${outputDir}`);
console.log(`Total on disk: ${fmt(sum([...archived, ...orphans, ...active]))}`);

report("ARCHIVED (reclaimable under the retention policy)", archived);
report("ORPHANED (folder on disk, no reel row)", orphans,
  "Deleted only with --orphans. Check these before removing.");
report("ACTIVE (still in the pipeline — never touched)", active,
  "These are left alone regardless of flags.");

const targets = INCLUDE_ORPHANS ? [...archived, ...orphans] : archived;
const reclaimable = sum(targets);

if (!DELETE) {
  console.log(
    `\nDRY RUN. Would delete ${targets.length} folder(s), freeing ${fmt(reclaimable)}.` +
      `\nRe-run with --delete to apply${INCLUDE_ORPHANS ? "" : " (add --orphans to include orphans)"}.`
  );
  await pool.end();
  process.exit(0);
}

let freed = 0;
for (const r of targets) {
  const resolved = path.resolve(r.full);
  if (!resolved.startsWith(path.resolve(outputDir) + path.sep)) {
    console.error(`  SKIP (outside volume): ${resolved}`);
    continue;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  freed += r.bytes;
  console.log(`  deleted ${r.name} (${fmt(r.bytes)})`);
}

// Keep the DB honest: a reel whose files are gone must not still advertise
// download paths. Mirrors clearMediaPaths() in lib/reels.ts.
const archivedIds = archived.map((r) => r.reel.id);
if (archivedIds.length > 0) {
  await pool.query(
    `UPDATE reels
       SET voiceover_status = 'none', voiceover_path = NULL,
           voiceover_error = NULL, voiceover_alignment = NULL,
           source_video_path = NULL,
           captions_status = 'none', captions_video_path = NULL,
           captions_error = NULL
     WHERE id = ANY($1::int[])`,
    [archivedIds]
  );
  console.log(`  cleared media paths for ${archivedIds.length} archived reel(s)`);
}

console.log(`\nDone. Freed ${fmt(freed)}.`);
await pool.end();
