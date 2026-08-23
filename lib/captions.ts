import type { VoiceoverAlignment } from "./types";
import { measureTextWidth } from "./textLayout";

export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

// Turns ElevenLabs' character-level alignment into word-level timings by
// walking the character array and splitting on whitespace runs — the
// alignment's `characters` array is the exact input text, so this is a
// straightforward reconstruction rather than a guess.
export function alignmentToWordTimings(alignment: VoiceoverAlignment): WordTiming[] {
  const { characters, character_start_times_seconds, character_end_times_seconds } =
    alignment;
  const words: WordTiming[] = [];
  let current = "";
  let start = 0;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      if (current) {
        words.push({ word: current, start, end: character_end_times_seconds[i - 1] });
        current = "";
      }
      continue;
    }
    if (!current) start = character_start_times_seconds[i];
    current += ch;
  }
  if (current) {
    words.push({
      word: current,
      start,
      end: character_end_times_seconds[characters.length - 1],
    });
  }
  return words;
}

const MIN_CUE_SECONDS = 0.12;
const MAX_WORDS_PER_LINE = 5;
// A gap this long between two words is a real clause/sentence break, not
// just natural speech cadence — width is the primary line-break driver
// (see LINE_WIDTH_RATIO), this only catches genuine pauses.
const PAUSE_BREAK_SECONDS = 1.1;
const LINE_WIDTH_RATIO = 0.72;

interface PositionedWord extends WordTiming {
  x: number; // left edge, px, in video-pixel coordinate space (for box placement only)
  width: number;
}

interface Line {
  words: PositionedWord[];
  text: string; // the full phrase, as libass will natively shape and center it
  start: number;
  end: number;
}

// Shared by layoutLines (word-width measurement, for box placement) and
// linesToAss (the ASS Style line) — both must agree on the exact same font
// size or the highlight box won't land under the right word.
//
// Ratio measured directly off the reference clip (2-Home.mp4) at its native
// 720x1280 — cap-height is a consistent ~32px across every sampled line
// ("IS THROWING MONEY AWAY.", "YOU PAY INTEREST FIRST", "OFTEN OUTGROWS"),
// not the ~24px/~60px split an earlier, noisier measurement pass suggested
// (that was contaminated by picking up a shirt cuff as text in some
// samples). Montserrat Black's true cap-height is 0.7 of its nominal size
// (font.capHeight / font.unitsPerEm, read directly off the font file) ->
// fontSize ~= 32/0.7 = 46px on a 1280px-tall frame.
export function captionFontSize(videoHeight: number): number {
  return Math.round(videoHeight * 0.036);
}

// Montserrat Black's cap-height as a fraction of its nominal font size —
// read directly from the font file (font.capHeight / font.unitsPerEm),
// not an estimate. Used to size the highlight box to the text.
export const CAP_HEIGHT_RATIO = 0.7;

// libass's \an2 (bottom-center) anchor does NOT sit at the visual glyph
// baseline in this renderer — measured (rendered a line, cropped, compared
// box padding to letter position) at ~9-11px below the true baseline at
// fontSize 46, i.e. roughly font.descent/font.unitsPerEm (0.251, read off
// the font file) of the nominal font size. The anchor sits at the
// descent line, not the baseline. Without correcting for this, both the
// text and the highlight box render ~0.25*fontSize lower than intended,
// and — because the box math was (wrongly) anchored off the same
// uncorrected point — the box reads as bottom-heavy: comfortable gap above
// the letters, cramped/too-tall gap below.
const ANCHOR_TO_BASELINE_RATIO = 0.251;

// Baseline of the reference clip's caption row, as a fraction of frame
// height (measured bottom edge, y=862 of 1280) — this stays FIXED as font
// size varies (confirmed across both the small- and large-caption segments,
// which share the same bottom edge and only extend upward differently). This
// is the TRUE visual baseline target — callers needing the raw \an2 \pos
// anchor (which sits below this) should add fontSize*ANCHOR_TO_BASELINE_RATIO.
export function captionBaselineY(videoHeight: number): number {
  return Math.round(videoHeight * 0.6734);
}

// Groups words into short on-screen phrases and measures where each word
// would fall in a naturally-centered line — used only to place the
// highlight box (see linesToAss); the phrase text itself is rendered as a
// single native string so the renderer's own text shaping handles
// spacing/kerning/centering, not manual per-word placement.
export function layoutLines(
  words: WordTiming[],
  videoWidth: number,
  fontSizePx: number
): Line[] {
  const spaceWidth = Math.max(
    measureTextWidth("I I", fontSizePx) - 2 * measureTextWidth("I", fontSizePx),
    fontSizePx * 0.25
  );
  const maxWidth = videoWidth * LINE_WIDTH_RATIO;

  const lines: Line[] = [];
  let i = 0;
  while (i < words.length) {
    const group: WordTiming[] = [words[i]];
    const widths = [measureTextWidth(words[i].word.toUpperCase(), fontSizePx)];
    let totalWidth = widths[0];
    let j = i + 1;
    while (j < words.length && group.length < MAX_WORDS_PER_LINE) {
      const gap = words[j].start - words[j - 1].end;
      if (gap > PAUSE_BREAK_SECONDS) break;
      const w = measureTextWidth(words[j].word.toUpperCase(), fontSizePx);
      if (totalWidth + spaceWidth + w > maxWidth) break;
      group.push(words[j]);
      widths.push(w);
      totalWidth += spaceWidth + w;
      j++;
    }

    let x = -totalWidth / 2; // centered around 0; shifted to video center below
    const positioned: PositionedWord[] = group.map((w, k) => {
      const pw: PositionedWord = { ...w, x, width: widths[k] };
      x += widths[k] + spaceWidth;
      return pw;
    });
    const offset = videoWidth / 2;
    for (const w of positioned) w.x += offset;

    const start = positioned[0].start;
    const end = Math.max(positioned[positioned.length - 1].end, start + MIN_CUE_SECONDS);
    const text = group.map((w) => w.word.toUpperCase()).join(" ");
    lines.push({ words: positioned, text, start, end });
    i = j;
  }
  return lines;
}

function formatAssTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(
    c
  ).padStart(2, "0")}`;
}

function escapeAssText(s: string): string {
  return s.replace(/\\/g, "").replace(/[\n\r]+/g, " ").replace(/\{/g, "(").replace(/\}/g, ")");
}

// Cubic-bezier rounded-rectangle as an ASS \p vector drawing path (clockwise
// from just right of the top-left corner). kappa is the standard circle-via-
// bezier approximation constant.
const KAPPA = 0.5522847498;
function roundedRectPath(x0: number, y0: number, x1: number, y1: number, r: number): string {
  const k = r * KAPPA;
  const n = (v: number) => Math.round(v * 10) / 10;
  return (
    `m ${n(x0 + r)} ${n(y0)} ` +
    `l ${n(x1 - r)} ${n(y0)} ` +
    `b ${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} ` +
    `l ${n(x1)} ${n(y1 - r)} ` +
    `b ${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} ` +
    `l ${n(x0 + r)} ${n(y1)} ` +
    `b ${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} ` +
    `l ${n(x0)} ${n(y0 + r)} ` +
    `b ${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)}`
  );
}

// Renders lines as an ASS subtitle file sized to the source video's own
// resolution. The phrase itself is ONE native Dialogue line per cue (\an2,
// bottom-anchored at the reference's own measured baseline — which stays
// fixed regardless of font size, unlike a vertical center) — libass does
// all the text shaping, so spacing/kerning/centering come out exactly as
// normal subtitle text would, not stretched or manually placed. The
// highlight is a separately-drawn rounded black box (Layer 0, below the
// text) sized to the currently-spoken word from layoutLines' measurements,
// visible only during that word's own time window — same text style
// throughout (no second style/BorderStyle to drift out of sync with the
// first).
export function linesToAss(lines: Line[], width: number, height: number): string {
  const fontSize = captionFontSize(height);
  // True visual baseline (used for the box, which we position ourselves)
  // vs. the raw \pos anchor \an2 actually keys off (below the baseline —
  // see ANCHOR_TO_BASELINE_RATIO) — passing baselineY straight to \pos
  // would render the text, and consequently the box hugging it, too low
  // and asymmetrically padded.
  const baselineY = captionBaselineY(height);
  const anchorY = Math.round(baselineY + fontSize * ANCHOR_TO_BASELINE_RATIO);
  const capHeight = fontSize * CAP_HEIGHT_RATIO;
  // Tight, reference-matched padding — the box should hug the word, not
  // encroach on its neighbors on the same line. Equal top and bottom
  // padding off the cap-height box (a prior asymmetric version — more
  // padding below than above, on an unverified "optical overshoot" theory
  // — was visibly lopsided, not subtle; removed).
  const padX = Math.round(fontSize * 0.16);
  const padY = Math.round(fontSize * 0.14);
  const cornerRadius = Math.round(fontSize * 0.14);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Plain,Montserrat Black,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,0,0,0,1
Style: Box,Montserrat Black,${fontSize},&H00000000,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  for (const line of lines) {
    events.push(
      `Dialogue: 1,${formatAssTime(line.start)},${formatAssTime(line.end)},Plain,,0,0,0,,{\\an2\\pos(${
        width / 2
      },${anchorY})}${escapeAssText(line.text)}`
    );
    for (const w of line.words) {
      const path = roundedRectPath(
        w.x - padX,
        baselineY - capHeight - padY,
        w.x + w.width + padX,
        baselineY + padY,
        cornerRadius
      );
      events.push(
        `Dialogue: 0,${formatAssTime(w.start)},${formatAssTime(
          w.end
        )},Box,,0,0,0,,{\\an7\\pos(0,0)\\p1}${path}{\\p0}`
      );
    }
  }
  return header + events.join("\n") + "\n";
}
