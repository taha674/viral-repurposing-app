import path from "node:path";
import * as fontkit from "fontkit";

const FONT_PATH = path.join(process.cwd(), "assets", "fonts", "Montserrat-Black.ttf");

// Lazy singleton — parsing the font file is cheap but no reason to redo it
// per word. Pure-JS metrics only (glyph advance widths), no rendering.
let _font: fontkit.Font | null = null;
function getFont(): fontkit.Font {
  if (!_font) _font = fontkit.openSync(FONT_PATH) as fontkit.Font;
  return _font;
}

// CALIBRATION: fontkit's raw advanceWidth/unitsPerEm math does not match
// what libass/ffmpeg's `ass` filter actually renders for this font — measured
// empirically (rendered a string, cropped the frame, measured the pixel
// span) at ~0.6x of fontkit's predicted width, consistently across several
// test strings, on this machine (macOS, libass using the "coretext" font
// provider per its own log output). Root cause not fully nailed down; this
// is a measured fudge factor, not a principled unit conversion.
//
// ⚠️ Portability risk: Railway runs Linux, where ffmpeg-static's libass
// almost certainly uses fontconfig/freetype instead of coretext, and this
// factor may not carry over. If highlight boxes land in the wrong place
// after deploying, re-run the calibration in the deployed environment
// (render a known string via the exact prod ffmpeg binary, measure its
// pixel span, compare to measureTextWidth's raw output) and adjust this
// constant — don't assume the Mac-derived value is correct on Linux.
const WIDTH_CALIBRATION = 0.62;

// Width of `text` in pixels when set in the bundled font at `fontSizePx` —
// used to lay out per-word caption highlight boxes at exact pixel
// positions (see captions.ts). Calibrated against actual libass rendering,
// not just raw font-file metrics — see WIDTH_CALIBRATION above.
export function measureTextWidth(text: string, fontSizePx: number): number {
  const font = getFont();
  const run = font.layout(text);
  return (run.advanceWidth / font.unitsPerEm) * fontSizePx * WIDTH_CALIBRATION;
}
