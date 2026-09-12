// Publish-pack prompt (2026-09-12) — the second, independent Gemini call.
//
// Deliberately NOT folded into ADAPTATION_SCHEMA / buildSystemPrompt(), for
// two concrete reasons:
//   1. ADAPT_MAX_OUTPUT_TOKENS is 2000 and MAX_TOKENS is a hard throw in
//      gemini.ts#extractResult — adding four more fields to that call would
//      put it near the ceiling on long scripts.
//   2. If the operator has ever saved a custom adaptation prompt, the
//      settings override is returned verbatim (prompt.ts#getEffectiveSystemPrompt).
//      New *required* schema fields would then arrive with no prompt text
//      explaining them, and get hallucinated. A separate prompt + separate
//      settings key can't hit that.
//
// Scope note (CLAUDE.md, 2026-09-12 carve-out): everything here produces
// DRAFTS the operator edits and chooses from. The app never posts, never
// commits to a final tag set, and never touches the platform's
// AI-generated-content toggle.

import { getSetting, setSetting, deleteSetting } from "./settings";
// One red-line list, never a second copy — this is the same list the
// adaptation step edits against.
import { RED_LINES } from "./prompt";
import type { Analysis, HookMode, RedLineFlag } from "./types";

const PUBLISH_PROMPT_SETTING_KEY = "publish_pack_system_prompt";

// A real subtitle line and the moment it is fully drawn on screen, computed
// from the reel's own word timings (see service.ts#coverCandidates). The
// model picks one BY INDEX rather than emitting a timestamp, so it cannot
// invent a frame that doesn't exist.
export interface CoverCandidate {
  seconds: number;
  text: string;
}

export interface PublishPackInput {
  adaptedScript: string;
  analysis: Analysis | null;
  sourceCaptionBody: string | null;
  sourceHashtags: string[];
  coverCandidates: CoverCandidate[];
}

// What the model returns. Differs from the persisted PublishPack in one
// place: the cover frame comes back as an index into coverCandidates, which
// the service resolves into seconds + text.
export interface PublishPackResult {
  caption: string;
  caption_rationale: string;
  hashtags: string[];
  hashtags_rejected: string[];
  thumbnail_text: {
    text: string;
    technique: string;
    why_not_clickbait: string;
  }[];
  hook_mode: HookMode;
  hook_mode_reason: string;
  cover_frame_index: number;
  red_line_flag: RedLineFlag;
  red_line_reason: string;
}

export function buildPublishSystemPrompt(): string {
  const redLines = RED_LINES.map((r, i) => `  ${i + 1}. ${r}`).join("\n");
  return `You prepare the post metadata for a finished Cyrus Amin short-form video:
the Instagram caption, the hashtag set, and the text hook that goes on the cover
frame. Everything you produce is a DRAFT for a human to edit and choose from.

## Red lines — these govern everything you write

${redLines}

How they apply to this task specifically:
- The caption must not promise an outcome that isn't in the script (red lines 7, 8).
- No countdown, "only X spots", "closing soon", or any other manufactured
  urgency in the caption or the CTA (red line 8).
- No "link in bio" framing that implies something is being sold or gated when
  the script doesn't say so (red line 8).
- Red line 5 means the caption must NOT contain an AI disclosure. Do not write
  one, do not hint at one, and do not mention the platform's AI-content
  setting — that decision belongs to the operator and is made outside this app.
- A cover text hook that the video does not actually pay off is deception
  (red lines 6 and 9). This is the single most important constraint below.

Set red_line_flag to "needs_review" if any part of what you produced is a
borderline call, and "rejected" if the script itself can't be given a compliant
caption or hook. Explain in red_line_reason. "none" means everything you wrote
is clearly compliant.

## 1. The caption

Write the caption for CYRUS's version of this video, from the adapted script.
You may be shown the SOURCE reel's caption as a structural reference — study how
it opens, how long it is, whether it asks a question, where its CTA sits — but
do NOT copy its wording, and do not carry over any non-compliant framing it has.

- Open with a line that stands on its own; Instagram truncates after roughly
  125 characters, so the first sentence has to work alone.
- Match the script's register. Do not add hype the script doesn't have.
- 1–4 short paragraphs. A question or a simple invitation to reply is a fine
  close; a hard sell is not.
- Do not put hashtags in the caption — they are returned separately.

## 2. The hashtags

Return 8–15 tags WITHOUT the leading '#'. Aim for a mix of broad-reach tags and
specific ones that actually describe this video's subject. If you are shown the
source reel's tags, treat them as evidence about what worked for this content —
keep the ones that genuinely fit, and put the ones you deliberately dropped in
hashtags_rejected with a short reason appended (e.g. "getrichquick — grift
framing"). Drop any tag that implies guaranteed returns, speculation, debt or
leverage tactics, or hustle-bro identity.

## 3. The cover text hook — this is the craft part

Instagram lets the operator pick any frame of the reel as the cover, and this
video has word-by-word subtitles burned in. So a frame that already carries a
subtitle line IS a text hook. Separately, a text sticker can be placed over the
cover. Your job is to write the text AND decide how to carry it.

### Writing the text (thumbnail_text — give exactly 3 options)

- **2–5 words.** A fragment, never a sentence. No commas, no conjunctions, no
  "and"/"but"/"because". Shorter almost always wins at cover scale.
- **Concrete, not abstract.** Nameable things, specific nouns, numbers. This is
  the single biggest separator between curiosity and clickbait — abstract teases
  measurably *reduce* clicks, they don't raise them. BANNED, and this list is
  not exhaustive: "this changes everything", "you won't believe", "the truth
  about", "nobody talks about this", "this is why", "watch this".
- **Open the loop, don't close it.** State the setup; withhold the resolution.
  If someone can answer the question from the text alone, it's dead.
- **Calibrate the gap.** Curiosity fires when the text opens a gap relative to
  what the viewer already knows. Too vague and there's no gap to feel; too
  explicit and there's nothing left to find out.
- **Specificity creates believability.** A specific claim reads as news. A vague
  one reads as marketing, and marketing gets scrolled past.
- **The satisfaction test, and you must state it per option.** In
  why_not_clickbait, name the moment in the script that pays this text off. If
  you cannot point to one, the option is clickbait — rewrite it or flag it.
- In "technique", name the mechanism in a few words (e.g. "unexpected
  juxtaposition", "prohibition framing", "specific number, withheld reason").
- Write the text in UPPERCASE — it will be rendered in a heavy display face.

### Choosing how to carry it (hook_mode)

You are given the actual subtitle lines from the start of the video, each with
the timestamp where it is fully on screen. Pick ONE mode:

- **"subtitle_only"** — one of those subtitle lines is already a complete,
  concrete curiosity hook on its own, and a sticker would only repeat it. This
  is the cleanest look: overlaid text competes with the speaker and makes the
  frame read like an ad. Prefer this when it genuinely works.
- **"sticker_only"** — the early subtitle lines are weak, generic, or cut
  mid-sentence, OR the strongest hook is a reframe that only arrives later in
  the script so no early frame carries it. The sticker can say something the
  script never says out loud.
- **"subtitle_plus_sticker"** — the subtitle carries the SETUP and the sticker
  adds the GAP: two different pieces of information that combine. Never a
  restatement of each other. Only choose this when they genuinely don't compete
  — two text elements fighting for the same frame costs more than it adds.

Set cover_frame_index to the 0-based index of the subtitle line to use as the
cover frame. Use -1 for "sticker_only", or if no candidates were provided.
Explain the choice in hook_mode_reason, referring to the actual lines you were
given.

## Output

Return ONLY a JSON object matching the required schema — no prose, no markdown
fences, no commentary before or after.`;
}

export function buildPublishUserMessage(input: PublishPackInput): string {
  const parts: string[] = [];

  parts.push(
    `Here is the finished, red-line-compliant script for Cyrus's video:\n\n"""\n${input.adaptedScript.trim()}\n"""`
  );

  if (input.analysis) {
    const a = input.analysis;
    parts.push(
      `Structural breakdown of the source reel this was adapted from:\n` +
        `- Hook: ${a.hook}\n` +
        `- Reframe: ${a.reframe}\n` +
        `- Mechanism: ${a.mechanism}\n` +
        `- Philosophical close: ${a.philosophical_close}\n` +
        `- CTA: ${a.cta}\n` +
        `- Top psychological triggers: ${
          a.top_psychological_triggers?.join(", ") || "—"
        }`
    );
  }

  // Absence is stated explicitly rather than left out. A silently missing
  // section reads to the model as "there was nothing notable here"; saying
  // "not captured" keeps it from inventing a source caption to react to.
  parts.push(
    input.sourceCaptionBody
      ? `The SOURCE reel's caption, for structural reference only — do not copy its wording:\n\n"""\n${input.sourceCaptionBody.trim()}\n"""`
      : `The source reel's caption was not captured for this reel. Write the caption from the script alone.`
  );

  parts.push(
    input.sourceHashtags.length
      ? `The SOURCE reel's hashtags: ${input.sourceHashtags
          .map((t) => `#${t}`)
          .join(" ")}`
      : `The source reel's hashtags were not captured for this reel. Choose tags from the script's subject matter alone, and leave hashtags_rejected empty.`
  );

  parts.push(
    input.coverCandidates.length
      ? `Subtitle lines available as cover frames (0-based index — pick one of these by index, or -1):\n` +
          input.coverCandidates
            .map((c, i) => `  [${i}] ${c.seconds.toFixed(2)}s — "${c.text}"`)
            .join("\n")
      : `No subtitle timings are available for this reel yet, so no cover frame can be chosen. Use cover_frame_index -1, and choose "sticker_only" unless you explain otherwise.`
  );

  parts.push(
    `Produce the caption, hashtags, and cover text hook, and return the structured JSON result.`
  );

  return parts.join("\n\n");
}

// --- User-editable system prompt (same override pattern as prompt.ts) ---
// Separate settings key from the adaptation prompt, so customizing one never
// affects the other.

export function getDefaultPublishSystemPrompt(): string {
  return buildPublishSystemPrompt();
}

export async function getEffectivePublishSystemPrompt(): Promise<string> {
  const override = await getSetting(PUBLISH_PROMPT_SETTING_KEY);
  return override?.trim() ? override : buildPublishSystemPrompt();
}

export async function isPublishSystemPromptCustomized(): Promise<boolean> {
  const override = await getSetting(PUBLISH_PROMPT_SETTING_KEY);
  return !!override?.trim();
}

export async function setCustomPublishSystemPrompt(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error(
      "System prompt cannot be empty — use Reset to restore the default instead."
    );
  }
  await setSetting(PUBLISH_PROMPT_SETTING_KEY, trimmed);
}

export async function resetPublishSystemPrompt(): Promise<void> {
  await deleteSetting(PUBLISH_PROMPT_SETTING_KEY);
}

// Gemini structured-output schema. Same subset rules as ADAPTATION_SCHEMA in
// prompt.ts: type/properties/required/items/enum/description/additionalProperties,
// plus Gemini's non-standard propertyOrdering.
//
// Note cover_frame_index is an integer, not a nullable timestamp: making the
// model choose from the candidate list we sent means it cannot emit a frame
// that doesn't exist. The service maps the index back to seconds + text.
export const PUBLISH_PACK_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    caption: {
      type: "string",
      description:
        "The suggested Instagram caption. No hashtags — those go in `hashtags`.",
    },
    caption_rationale: {
      type: "string",
      description: "One or two sentences on why the caption is built this way.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "8-15 hashtags, WITHOUT the leading '#'.",
    },
    hashtags_rejected: {
      type: "array",
      items: { type: "string" },
      description:
        "Source tags deliberately dropped, each with a short reason appended. Empty if no source tags were provided.",
    },
    thumbnail_text: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: {
            type: "string",
            description: "2-5 words, uppercase, a fragment not a sentence.",
          },
          technique: {
            type: "string",
            description: "The curiosity mechanism, named in a few words.",
          },
          why_not_clickbait: {
            type: "string",
            description:
              "The specific moment in the script that pays this text off.",
          },
        },
        required: ["text", "technique", "why_not_clickbait"],
        propertyOrdering: ["text", "technique", "why_not_clickbait"],
      },
      description: "Exactly 3 cover text options.",
    },
    hook_mode: {
      type: "string",
      enum: ["subtitle_only", "sticker_only", "subtitle_plus_sticker"],
    },
    hook_mode_reason: {
      type: "string",
      description:
        "Why this mode, referring to the actual candidate subtitle lines provided.",
    },
    cover_frame_index: {
      type: "integer",
      description:
        "0-based index into the cover frame candidates provided. -1 for sticker_only, or when no candidates exist.",
    },
    red_line_flag: {
      type: "string",
      enum: ["none", "needs_review", "rejected"],
    },
    red_line_reason: {
      type: "string",
      description:
        "Why this flag was chosen. Empty string if red_line_flag is 'none'.",
    },
  },
  required: [
    "caption",
    "caption_rationale",
    "hashtags",
    "hashtags_rejected",
    "thumbnail_text",
    "hook_mode",
    "hook_mode_reason",
    "cover_frame_index",
    "red_line_flag",
    "red_line_reason",
  ],
  // Caption first (it forces engagement with the script's substance before
  // the short-form hook work), flag last so it's chosen with everything the
  // model just wrote already in context.
  propertyOrdering: [
    "caption",
    "caption_rationale",
    "hashtags",
    "hashtags_rejected",
    "thumbnail_text",
    "hook_mode",
    "hook_mode_reason",
    "cover_frame_index",
    "red_line_flag",
    "red_line_reason",
  ],
} as const;
