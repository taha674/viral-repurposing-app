// Adaptation prompt — written fresh for this app (NOT reused from the
// cyrus-script-writer skill). Source of truth for the transform is
// ../reference-inputs.md:
//   - Repurposing = MINIMAL edits for red-line compliance. Do NOT insert a
//     unique Cyrus voice. Preserve the original script as much as possible.
//   - Full combined red-line list (PRD §8 halal filter + Taha's 3 additions).
//   - Flag rather than force when the source can't be made compliant.

import { getSetting, setSetting, deleteSetting } from "./settings";

const SYSTEM_PROMPT_SETTING_KEY = "adaptation_system_prompt";

export const RED_LINES: string[] = [
  // From PRD §8 (halal filter)
  "No debt or leverage advice.",
  "No speculation-based income framing (no framing income as coming from speculation/gambling-like bets).",
  "No pseudoscience.",
  "No hustle-bro language.",
  'No explicit "this is AI" disclosure.',
  "No active deception (no attempt to make the audience believe something false about the real world).",
  // Added by Taha 2026-07-18
  "No baseless factual claims — every mechanism described must be real and verifiable.",
  "No grifting — no fake scarcity, no inflated promises, no deceptive CTAs.",
  "No highly deceptive behaviour. NOTE: fictional character stories (e.g. \"my father told me this\") are explicitly ALLOWED and are NOT a violation — a first-person narrative frame around a real, sound principle is fine.",
];

// The structured result the model must return.
export interface AdaptationResult {
  analysis: {
    hook: string;
    reframe: string;
    mechanism: string;
    philosophical_close: string;
    cta: string;
    top_psychological_triggers: string[];
  };
  adapted_script: string;
  red_line_flag: "none" | "needs_review" | "rejected";
  red_line_reason: string;
  edits_made: string[];
}

export function buildSystemPrompt(): string {
  const redLines = RED_LINES.map((r, i) => `  ${i + 1}. ${r}`).join("\n");
  return `You adapt viral short-form video scripts for the Cyrus Amin brand.

## Your job: MINIMAL red-line-compliance editing — NOT a voice rewrite

You are given the transcript of a proven viral reel. Cyrus repurposes the
STRUCTURE of what already works. Your task is to make the SMALLEST possible set
of edits so the script crosses none of the red lines below, while preserving the
original wording, rhythm, hook, and structure as much as possible.

CRITICAL rules for the edit:
- Do NOT rewrite the script into a distinct "Cyrus voice." Do NOT restyle,
  embellish, or improve prose that is already compliant. Leave compliant text
  untouched, word for word.
- Only change what is necessary to remove a red-line violation. Prefer the
  lightest touch: swap a non-compliant claim for a compliant equivalent, cut a
  non-compliant line, or soften an over-promise — rather than reworking whole
  sections.
- Preserve the length, pacing, and beat structure of the original.
- **CRITICAL: Do not replace a red-line violation with a vaguer version of the
  same violation.** Example: "Always say three left" (fake scarcity) should
  become "Get started now" (no scarcity claim), NOT "Always say limited spots
  left" (still fake scarcity, just vaguer). If you cannot fix a violation with
  a genuinely compliant phrase, flag it instead of forcing a pseudo-fix.

## Red lines (the ONLY thing you edit for)

${redLines}

## Flag rules — CRITICAL for compliance

The red_line_flag MUST reflect your actual edits. This is non-negotiable:
- If you make ANY edits to the adapted_script for compliance reasons (because
  you detected and fixed a red-line violation), you MUST set the flag to at
  least "needs_review". Never report "none" if you edited something.
- "none" means: the source was already compliant, NO edits were needed.
- "needs_review" means: you made edits and the human should verify your judgment
  (a borderline claim, an ambiguous reframe, or uncertainty about whether the
  fix is truly compliant).
- "rejected" means: you could not fix the violation without abandoning the
  core premise, or the source is fundamentally non-compliant.

## When the source can't be salvaged with minimal edits — FLAG, don't force

If the reel's core premise IS the violation (e.g. the entire hook is a
debt-leverage tactic, or the whole payload is an unverifiable claim), do NOT
invent a new script to force compliance. Instead:
- Set red_line_flag to "rejected" and explain why in red_line_reason.
- Still return your best minimal-edit attempt in adapted_script IF a salvage is
  plausible, otherwise return the original transcript unchanged in
  adapted_script and make clear in red_line_reason that a human must decide.

## Also produce a structural breakdown (analysis) of the SOURCE

Independent of the edit, break the ORIGINAL reel down into: hook, reframe,
mechanism, philosophical_close, cta, and the top 3 psychological triggers. This
mirrors the existing analysis format and is descriptive of the source, not the
edited version.

## Output

Return ONLY a JSON object matching the required schema — no prose, no markdown
fences, no commentary before or after.`;
}

export function buildUserMessage(transcript: string): string {
  return `Here is the transcript of the viral reel to adapt:\n\n"""\n${transcript.trim()}\n"""\n\nApply minimal red-line-compliance editing and return the structured JSON result.`;
}

// --- User-editable system prompt (persisted override, code is the default) ---
//
// The operator can tune the adaptation system prompt from the UI (Settings
// page) without a code change. A saved override lives in the `settings`
// table; absence of one means "use buildSystemPrompt() as-is". Resetting
// deletes the override, so a later code change to buildSystemPrompt()
// automatically becomes the new default again.

// The as-shipped prompt, ignoring any operator override. Used as the "Reset
// to default" target and to show the operator what the baseline looks like.
export function getDefaultSystemPrompt(): string {
  return buildSystemPrompt();
}

// What actually gets sent to Gemini: the operator's saved override if present
// and non-empty, otherwise the code default.
export async function getEffectiveSystemPrompt(): Promise<string> {
  const override = await getSetting(SYSTEM_PROMPT_SETTING_KEY);
  return override?.trim() ? override : buildSystemPrompt();
}

export async function isSystemPromptCustomized(): Promise<boolean> {
  const override = await getSetting(SYSTEM_PROMPT_SETTING_KEY);
  return !!override?.trim();
}

export async function setCustomSystemPrompt(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error(
      "System prompt cannot be empty — use Reset to restore the default instead."
    );
  }
  await setSetting(SYSTEM_PROMPT_SETTING_KEY, trimmed);
}

export async function resetSystemPrompt(): Promise<void> {
  await deleteSetting(SYSTEM_PROMPT_SETTING_KEY);
}

// JSON schema for Gemini structured output (config.responseJsonSchema, paired
// with responseMimeType: "application/json"). Gemini supports a subset of JSON
// Schema — the keywords used here (type, properties, required, items, enum,
// description, additionalProperties) are all in it. `propertyOrdering` is
// Gemini's non-standard hint that keeps field order stable across calls, which
// matters because the model generates the JSON token by token.
export const ADAPTATION_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    analysis: {
      type: "object",
      additionalProperties: false,
      properties: {
        hook: { type: "string" },
        reframe: { type: "string" },
        mechanism: { type: "string" },
        philosophical_close: { type: "string" },
        cta: { type: "string" },
        top_psychological_triggers: {
          type: "array",
          items: { type: "string" },
          description: "Top 3 psychological triggers in the source.",
        },
      },
      required: [
        "hook",
        "reframe",
        "mechanism",
        "philosophical_close",
        "cta",
        "top_psychological_triggers",
      ],
      propertyOrdering: [
        "hook",
        "reframe",
        "mechanism",
        "philosophical_close",
        "cta",
        "top_psychological_triggers",
      ],
    },
    adapted_script: {
      type: "string",
      description:
        "The minimally-edited, red-line-compliant script. Preserves the original as much as possible.",
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
    edits_made: {
      type: "array",
      items: { type: "string" },
      description:
        "Short list of the specific edits made (empty if none needed).",
    },
  },
  required: [
    "analysis",
    "adapted_script",
    "red_line_flag",
    "red_line_reason",
    "edits_made",
  ],
  // analysis first: the model reasons about the source before emitting the edit.
  propertyOrdering: [
    "analysis",
    "adapted_script",
    "red_line_flag",
    "red_line_reason",
    "edits_made",
  ],
} as const;
