// Punch-in zoom scheduling (2026-09-12).
//
// Replicates the re-framing rhythm of the reference reels: the frame snaps
// tighter on the same continuous take, climbs a step or two or three, then
// releases to wide. What reads as a "cut" in this format IS the punch-in —
// no frames are removed.
//
// Removing frames is NOT an option here and never will be: the video is a
// HeyGen avatar render driven by an ElevenLabs voiceover, and the burn copies
// the audio stream through untouched. Trimming video would desync the
// avatar's lips from audio we are not re-cutting. So this only ever changes
// framing, never timing — segments tile the whole timeline with no gaps.
//
// --- Two hard-won ffmpeg facts, both measured on ffmpeg-static 6.0 ---
//
// 1. `scale=...:eval=frame , crop=W:H` LOOKS right and is WRONG. crop
//    evaluates w/h/x/y ONCE at init, when the frame is still WxH, so the
//    centring term computes to 0 and stays there while scale grows the frame
//    underneath. The result zooms toward the TOP-LEFT and slides the face out
//    of frame (measured: 41.4dB against a top-left model, 10.1dB against a
//    centred one). Passing x/y explicitly produces byte-identical output —
//    crop's `T` flag means "settable at runtime via sendcmd", NOT
//    "re-evaluated per frame". Cropping first with a shrinking window has the
//    same init-only problem and silently does nothing at all.
//
// 2. What works is rendering each hold as its own segment, so every segment
//    initialises with its own constant zoom, then concat. `setsar=1` on every
//    branch is mandatory — scale's rounding perturbs the sample aspect ratio
//    and concat refuses branches whose SAR disagrees.
//
// Tradeoff: hard cuts only, no eased ramps. For this style that is the
// authentic look. (zoompan is the correct filter if easing is ever wanted.)

import type { CaptionLine, WordTiming } from "./captions";

export interface PunchEvent {
  t: number; // seconds
  level: number; // 0 = wide, 1..maxLevel = progressively tighter
}

export interface PunchOptions {
  step: number; // zoom added per level, as a fraction of the base frame
  maxLevel: number; // ceiling — capped by resolution, see config
  minGapSeconds: number; // a word gap this long is a phrase break
  boundaryPercentile: number; // pauses above this percentile end a beat
  minBeatSeconds: number;
  maxBeatSeconds: number;
}

// A real pause in the delivery: the silence between two spoken words.
interface Gap {
  t: number; // midpoint of the pause: where the re-frame lands
  len: number; // how long the speaker is silent
}

// The pause signal has to come from WORD timings, not from caption lines.
// Measured on a real 60s render: gaps between caption lines were median 0 with
// only 5 distinct values across 39 gaps, because layoutLines() breaks on a
// 5-word cap and a width cap far more often than it breaks on a pause — so
// consecutive lines are usually contiguous and carry almost no rhythm. The
// same clip's WORD gaps had 19 distinct values with 18 breaks over 0.2s. That
// is the delivery's actual phrasing, and it is what the re-frames key off.
function phraseGaps(words: WordTiming[], minGapSeconds: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < words.length; i++) {
    const len = words[i].start - words[i - 1].end;
    if (len < minGapSeconds) continue;
    gaps.push({ t: +(words[i - 1].end + len / 2).toFixed(3), len: +len.toFixed(3) });
  }
  return gaps;
}

// Nudge a punch onto the nearest caption change, when one is close. A re-frame
// that lands exactly as the on-screen words change reads as one deliberate
// edit; one that lands mid-phrase reads as a glitch.
function snapToLine(t: number, lines: CaptionLine[], tolerance = 0.22): number {
  let best = t;
  let bestDist = tolerance;
  for (const l of lines) {
    const d = Math.abs(l.start - t);
    if (d < bestDist) {
      bestDist = d;
      best = l.start;
    }
  }
  return +best.toFixed(3);
}

function percentile(sortedAsc: number[], f: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.floor(f * (sortedAsc.length - 1)));
  return sortedAsc[i];
}

// Beat boundaries, chosen RELATIVE to this video's own pause distribution.
//
// An absolute "a pause longer than X seconds ends a beat" threshold does not
// survive contact with synthetic speech: measured across a real HeyGen
// render, every pause fell between 0.18s and 0.64s (median 0.37) because TTS
// doesn't breathe. A fixed 0.9s threshold fired zero times, so every release
// came from hitting the level ceiling instead — which is what made the first
// version a metronome, climbing 1-2-3 on repeat for the whole video.
function findBeatBoundaries(
  gaps: Gap[],
  duration: number,
  opts: PunchOptions
): number[] {
  const sorted = gaps.map((g) => g.len).sort((a, b) => a - b);
  const strong = percentile(sorted, opts.boundaryPercentile);

  const chosen: number[] = [];
  let last = 0;
  for (const g of gaps) {
    if (g.t < opts.minBeatSeconds || g.t > duration - opts.minBeatSeconds) continue;
    if (g.len < strong) continue;
    if (g.t - last < opts.minBeatSeconds) continue; // don't chop beats into slivers
    chosen.push(g.t);
    last = g.t;
  }

  // Split any over-long beat at its own longest internal pause, so a
  // monologue stretch still breathes.
  const out: number[] = [];
  let prev = 0;
  for (const b of [...chosen, duration]) {
    let start = prev;
    while (b - start > opts.maxBeatSeconds) {
      const inner = gaps
        .filter(
          (g) =>
            g.t > start + opts.minBeatSeconds &&
            g.t < Math.min(b, start + opts.maxBeatSeconds)
        )
        .sort((x, y) => y.len - x.len)[0];
      if (!inner) break;
      out.push(inner.t);
      start = inner.t;
    }
    if (b !== duration) out.push(b);
    prev = b;
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Climb within a beat, release at the beat boundary.
//
// The depth of each climb is NOT fixed — it's however many phrase breaks that
// beat actually contains, capped at maxLevel. A beat holding one phrase
// punches once and releases; a dense beat climbs to three; a beat with no
// internal break stays wide, which is a rest, and rests are what make the
// next climb register. Depth varies because the speech varies, not because a
// counter wrapped — that is the whole difference between this reading as an
// edit and reading as a metronome.
export function buildPunchSchedule(
  words: WordTiming[],
  lines: CaptionLine[],
  duration: number,
  opts: PunchOptions
): PunchEvent[] {
  if (words.length < 4 || !Number.isFinite(duration) || duration <= 0) return [];

  const gaps = phraseGaps(words, opts.minGapSeconds);
  if (gaps.length === 0) return [];

  const boundaries = findBeatBoundaries(gaps, duration, opts);
  const beats: { start: number; end: number }[] = [];
  let prev = 0;
  for (const b of [...boundaries, duration]) {
    beats.push({ start: prev, end: b });
    prev = b;
  }

  const events: PunchEvent[] = [];
  let level = 0;
  for (const beat of beats) {
    const inner = gaps
      .filter((g) => g.t > beat.start + 0.25 && g.t < beat.end - 0.25)
      .sort((a, b) => a.t - b.t);

    const depth = Math.min(opts.maxLevel, inner.length);
    for (let i = 0; i < depth; i++) {
      level = i + 1;
      events.push({ t: snapToLine(inner[i].t, lines), level });
    }
    if (level !== 0 && beat.end < duration - 0.4) {
      level = 0;
      events.push({ t: snapToLine(beat.end, lines), level });
    }
  }
  return events;
}

// Builds the video half of a -filter_complex graph: the punch-in segments,
// concatenated, left on the [punched] label for the caller to chain the ASS
// burn onto. Returns null when there's nothing to do, so the caller falls
// back to the plain single-filter path.
export function punchInFilter(
  events: PunchEvent[],
  width: number,
  height: number,
  duration: number,
  opts: PunchOptions,
  outLabel = "punched"
): string | null {
  if (events.length === 0) return null;

  // Segments tile [0, duration) with no gaps — this is what preserves
  // duration and frame count, and therefore A/V sync.
  const bounds = [0, ...events.map((e) => e.t), duration];
  const levels = [0, ...events.map((e) => e.level)];
  const segs: { from: number; to: number; level: number }[] = [];
  for (let i = 0; i < levels.length; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (!(to > from) || to - from < 0.05) continue; // drop sub-frame slivers
    segs.push({ from: +from.toFixed(3), to: +to.toFixed(3), level: levels[i] });
  }
  if (segs.length < 2) return null;

  const parts: string[] = [
    `[0:v]split=${segs.length}${segs.map((_, i) => `[pz${i}]`).join("")}`,
  ];
  segs.forEach((s, i) => {
    const z = 1 + opts.step * s.level;
    // Leave the final segment's trim open-ended so a rounding sliver at the
    // tail can't drop the last frame.
    const trim =
      i === segs.length - 1 ? `trim=start=${s.from}` : `trim=${s.from}:${s.to}`;
    // Level 0 is the untouched frame — don't resample it at all, so the wide
    // shots take no generation loss.
    const zoom =
      s.level === 0
        ? ""
        : `,scale=w=ceil(${width}*${z}/2)*2:h=ceil(${height}*${z}/2)*2,crop=${width}:${height}`;
    parts.push(`[pz${i}]${trim},setpts=PTS-STARTPTS${zoom},setsar=1[ps${i}]`);
  });
  parts.push(
    `${segs.map((_, i) => `[ps${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[${outLabel}]`
  );

  return parts.join(";");
}
