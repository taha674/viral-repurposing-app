// Volume retention — the pipeline's only mechanism for reclaiming disk.
//
// Why this exists: every completed reel leaves ~63MB on REELS_OUTPUT_DIR
// (a ~44MB HeyGen source export, a ~19MB subtitled output, a ~0.4MB
// voiceover). Before this module nothing ever deleted any of it, including
// for archived reels — archiving was a pure DB status change — so the
// Railway volume filled up and writes started failing with ENOSPC.
//
// Policy (operator's call, 2026-09-12): archiving a reel deletes its whole
// slug folder. Archive is the point at which the operator has downloaded
// the finished file and is done with the reel; nothing on the volume needs
// to outlive that.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export type PurgeResult = {
  dir: string;
  existed: boolean;
  files: string[];
  bytes: number;
};

// A reel's folder is always path.join(reelsOutputDir, slug) — see the
// writers in service.ts (voiceover, saveSourceVideo, burnCaptions).
export function reelDir(slug: string): string {
  return path.join(config.reelsOutputDir, slug);
}

// Guard against a slug that escapes the output dir (e.g. "..", an absolute
// path, or a separator smuggled in). mintSlug sanitizes to [a-z0-9-], so
// this should be unreachable — but this function deletes a directory tree
// recursively, and "should be unreachable" is not a good enough reason to
// skip the check on a destructive operation.
function assertInsideOutputDir(dir: string): void {
  const root = path.resolve(config.reelsOutputDir);
  const target = path.resolve(dir);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to delete ${target}: not a subdirectory of ${root}.`
    );
  }
}

// Sum the sizes of a folder's files, one level deep (reel folders are flat).
function measure(dir: string): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(entry.name);
      try {
        bytes += fs.statSync(full).size;
      } catch {
        // Raced with another delete — it's gone, which is the goal anyway.
      }
    }
  }
  return { files, bytes };
}

// Delete a reel's entire slug folder. Returns what was removed so callers
// can log it — a silent delete of the operator's finished video would be
// the wrong kind of quiet.
export function purgeReelFiles(slug: string | null | undefined): PurgeResult {
  if (!slug?.trim()) {
    return { dir: "", existed: false, files: [], bytes: 0 };
  }
  const dir = reelDir(slug);
  assertInsideOutputDir(dir);

  if (!fs.existsSync(dir)) {
    return { dir, existed: false, files: [], bytes: 0 };
  }

  const { files, bytes } = measure(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { dir, existed: true, files, bytes };
}

// Same inside-the-output-dir guard as purgeReelFiles, but for a single file
// rather than a whole slug folder — used for a burned reel's now-unneeded
// source video, which is deleted while its folder (voiceover, captioned
// output) stays. Returns bytes freed, 0 if the path is empty or already
// gone (both are fine — the goal is achieved either way).
export function deleteFileIfExists(filePath: string | null | undefined): number {
  if (!filePath?.trim()) return 0;
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.reelsOutputDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to delete ${resolved}: not inside ${root}.`);
  }
  if (!fs.existsSync(resolved)) return 0;
  const bytes = fs.statSync(resolved).size;
  fs.unlinkSync(resolved);
  return bytes;
}

// Total bytes currently on REELS_OUTPUT_DIR — the number the auto-purge
// threshold in config.volumePurgeThresholdMb is compared against. Walks the
// whole tree (folders are one level deep, so this is cheap at the pipeline's
// actual scale of tens of reels).
export function outputDirSizeBytes(): number {
  const root = config.reelsOutputDir;
  if (!fs.existsSync(root)) return 0;
  return dirSizeBytesRecursive(root);
}

function dirSizeBytesRecursive(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      bytes += dirSizeBytesRecursive(full);
    } else if (entry.isFile()) {
      try {
        bytes += fs.statSync(full).size;
      } catch {
        // Raced with a delete elsewhere — it's gone, so it costs nothing.
      }
    }
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
