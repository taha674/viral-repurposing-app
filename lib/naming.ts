// File-naming convention for everything a reel produces on disk.
//
// A reel gets one slug, minted once (on Accept — see reels.ts#mintSlug) and
// stored in reels.slug: "dd-mon-first-few-words", e.g.
// "23-aug-when-someone-says". Every later file — voiceover, uploaded source
// video, subtitled output — lives under a folder named for that slug and
// carries it as a filename prefix with a stage suffix. Minting it once (not
// re-deriving it per stage) means editing the transcript after acceptance
// never renames files already sitting on disk.

// Named constant, not a magic number — easy to retune if 4 words reads too
// long/short in practice (the plan's own example used 3).
const SLUG_WORD_COUNT = 4;
const SLUG_MAX_LEN = 40;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function datePart(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mon = MONTHS[date.getMonth()];
  return `${dd}-${mon}`;
}

function wordsPart(transcript: string | null | undefined): string | null {
  if (!transcript?.trim()) return null;
  const words = transcript
    .trim()
    .split(/\s+/)
    .slice(0, SLUG_WORD_COUNT)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean);
  if (words.length === 0) return null;
  const joined = words.join("-").slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  return joined || null;
}

// Pure slug computation — does not check for collisions (that needs a DB
// lookup, done by the caller in reels.ts).
export function baseSlug(date: Date, transcript: string | null | undefined, reelId: number): string {
  const words = wordsPart(transcript);
  if (!words) return `reel-${reelId}`;
  return `${datePart(date)}-${words}`;
}

export type ReelFileKind = "audio" | "source" | "subtitled";

// e.g. reelFileName("23-aug-when-someone-says", "audio", "mp3")
//   -> "23-aug-when-someone-says-audio.mp3"
export function reelFileName(slug: string, kind: ReelFileKind, ext: string): string {
  return `${slug}-${kind}.${ext}`;
}
