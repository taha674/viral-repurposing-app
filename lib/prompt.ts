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

// Distilled from the Fortress System landing page. This is the ONLY product
// context the model gets for the CTA rewrite — keep it accurate, and update
// it here (not ad hoc in the CTA) if the offer or pricing changes.
export const PRODUCT_CONTEXT = `THE FORTRESS SYSTEM — the product every adapted CTA points to.
Not a course, not a community, not a subscription. A book + a companion tracker, sold as one system.

- "Fortress of Certainty" (book, $9 standalone) — a six-pillar wealth-architecture framework, one chapter per pillar:
  1. The Time Tax — zero-leverage; debt reframed as a claim on your future working hours.
  2. The Sovereign Screen — three filters that separate real investing from speculation.
  3. Tangible Yields — real-world, asset-backed income (REITs, rental income, dividends) over "safe" bonds.
  4. The Asymmetric Bet — Citadel (safe) vs. Reach (speculative) allocation, Reach capped under 10%.
  5. The Ultimate Hedge — building income that outlives your salary and your hours.
  6. The Law of Circulation — giving as a structural habit, not sentiment.
- The Anti-Fragile Wealth Tracker (Excel/Google Sheets, $17 standalone) — one tab per pillar, gold-border cells for manual input, gray cells auto-calculated, produces a single 0-100 "Fortress Score" on open. Updated monthly, ~20 minutes, no bank or account connection (manual entry is intentional).
- Bundled together: $26.
- No leverage, no speculation, no trading tips. Never let the CTA promise a specific financial outcome, get-rich-quick result, or imply the book/tracker is personalized investment advice.`;

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
original wording, rhythm, hook, and structure as much as possible — with ONE
deliberate exception: the CTA, which you rewrite to segue into Cyrus's actual
product. See "CTA adaptation" below.

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

## Red lines (the ONLY thing you edit the BODY of the script for)

${redLines}

## Product context

${PRODUCT_CONTEXT}

## CTA adaptation — the one section you actively rewrite

Every other beat of the script (hook, reframe, mechanism, philosophical_close)
gets MINIMAL red-line edits only, per the rules above. The CTA is the
exception: rewrite it — don't just red-line it — so it segues naturally out of
the script's own closing idea into The Fortress System (see Product context
above). This rewrite is required on every script, independent of whether the
source's original CTA had a red-line violation.

- Bridge, don't jump-cut. Use the reel's own mechanism or closing idea as the
  launchpad into the pitch. Example: a reel about carrying debt bridges into
  the Time Tax pillar; a reel about chasing hot stocks bridges into the
  Sovereign Screen; a reel about needing a raise bridges into the Ultimate
  Hedge. If no single pillar fits, bridge to the book + tracker system
  generally — a clean, generic bridge beats a stretched, forced one.
- Match the original CTA's length and register: a short, spoken sign-off (one
  to three sentences), not an ad read. Don't expand it into a pitch that
  breaks the pacing of the rest of the adapted script.
- Describe the product accurately and only from the Product context above —
  a short book plus a companion Excel/Sheets tracker that scores your
  financial architecture monthly. Never invent features, testimonials,
  guarantees, results, or urgency that aren't in that description. Prices are
  optional in the CTA; only state them if they help the flow, and only as
  given above ($9 book / $17 tracker / $26 bundle).
- This is exactly where grifting, fake-scarcity, hustle-bro, and
  deceptive-CTA violations are most likely — hold the rewritten CTA to every
  red line above. No manufactured urgency ("only X left," "today only"), no
  promised financial outcomes, no implying the book/tracker is personalized
  financial advice.
- Prefer a natural point toward the book/tracker/system over a hard sell —
  the goal is a segue, not a pitch.

Note the CTA rewrite in edits_made, prefixed "CTA:" so it reads as separate
from any red-line fix elsewhere in the script.

## Flag rules — CRITICAL for compliance

red_line_flag tracks ONLY red-line fixes to the hook/reframe/mechanism/
philosophical_close — the mandatory CTA rewrite above does not by itself
change the flag. This is non-negotiable:
- If you make ANY edits outside the CTA for compliance reasons (because you
  detected and fixed a red-line violation), you MUST set the flag to at least
  "needs_review". Never report "none" if you edited something outside the CTA.
- "none" means: apart from the required CTA rewrite, the source was already
  compliant — no other edits were needed.
- "needs_review" means: you made edits outside the CTA and the human should
  verify your judgment (a borderline claim, an ambiguous reframe, or
  uncertainty about whether the fix is truly compliant).
- "rejected" means: you could not fix a violation outside the CTA without
  abandoning the core premise, or the source is fundamentally non-compliant.

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
        "The red-line-compliant script: minimally edited throughout, except the CTA, which is rewritten to segue into The Fortress System.",
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
