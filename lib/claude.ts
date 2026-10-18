import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { config, hasClaude } from "./config";
import { claudeAuth } from "./claudeAuth";
import type { Brand } from "./types";
import {
  getEffectiveSystemPrompt,
  buildUserMessage,
  adaptationSchema,
  type AdaptationResult,
} from "./prompt";
import {
  getEffectivePublishSystemPrompt,
  buildPublishUserMessage,
  PUBLISH_PACK_SCHEMA,
  type PublishPackInput,
  type PublishPackResult,
} from "./publishPrompt";

// Claude API replaced Gemini on 2026-10-18 for both brands (multi-brand.md §10).
//
// Retries: the SDK's own retry (429 / 5xx / connection errors only — schema,
// auth and refusal failures are never retried) with maxRetries set to
// CLAUDE_MAX_RETRIES, a HARD CAP (project rule: never loop silently against a
// paid API — failures surface to the operator).
//
// Thinking can't be disabled on the current Opus; effort (CLAUDE_EFFORT,
// default low) is the closest match to the old thinking-off Gemini calls.
// max_tokens counts thinking too, so the token knobs sit well above the
// visible output size.
// Anthropic direct by default; OpenRouter while ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_BASE_URL are set (temporary, see lib/config.ts).
function client(): Anthropic {
  return new Anthropic({
    ...claudeAuth({ apiKey: config.anthropicKey, authToken: config.anthropicAuthToken }),
    baseURL: config.anthropicBaseUrl,
    maxRetries: config.claudeMaxRetries,
  });
}

// One structured call, fail-loud on refusal / truncation / empty output:
// a human reviews the source rather than us retrying. `label` names the call
// and `tokenEnvVar` the knob to raise, so the operator gets an actionable
// message. No server-side model fallback: the model stays pinned, so a
// policy decline surfaces to the operator instead of running the red-line
// prompt on a model nobody chose.
async function callStructured<T>(opts: {
  system?: string;
  content: string | ContentBlockParam[];
  schema: object;
  maxTokens: number;
  label: string;
  tokenEnvVar: string;
}): Promise<T> {
  if (!hasClaude()) {
    throw new Error(
      `Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set. Add one to .env.local to run ${opts.label.toLowerCase()}.`
    );
  }
  let response;
  try {
    response = await client().messages.create({
      model: config.claudeModel,
      max_tokens: opts.maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.content }],
      output_config: {
        effort: config.claudeEffort,
        format: { type: "json_schema", schema: opts.schema as Record<string, unknown> },
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The SDK retries only 429 / 5xx / connection errors, so the attempt
    // count is "up to", not exact.
    throw new Error(
      `${opts.label} failed (up to ${config.claudeMaxRetries + 1} attempt(s)): ${detail}`
    );
  }

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new Error(
      `The model declined this request (${category}). Review the source manually.`
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `${opts.label} output was truncated (hit max_tokens). Raise ${opts.tokenEnvVar}.`
    );
  }

  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error(`${opts.label} returned no text output.`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${opts.label} output was not valid JSON. Raw output: ` + text.slice(0, 300)
    );
  }
}

// Runs the red-line-compliance adaptation prompt.
export async function runAdaptation(
  transcript: string,
  brand: Brand
): Promise<AdaptationResult> {
  if (!transcript.trim()) {
    throw new Error("Cannot adapt an empty transcript.");
  }
  return callStructured<AdaptationResult>({
    system: await getEffectiveSystemPrompt(brand),
    content: buildUserMessage(transcript),
    schema: adaptationSchema(brand),
    maxTokens: config.adaptMaxOutputTokens,
    label: "Adaptation",
    tokenEnvVar: "ADAPT_MAX_OUTPUT_TOKENS",
  });
}

// --- Carousel adaptation (ticket 10) ---
//
// Same brand system prompt (its red lines), asked for slides instead of a
// script. The prompt owner may want a dedicated carousel prompt later
// (open question); until then the instruction below rides in the user turn.
export interface CarouselSlide {
  headline: string;
  body: string;
}
export interface CarouselResult {
  slides: CarouselSlide[];
  red_line_flag: string;
  red_line_reason: string;
  edits_made: string[];
}

const CAROUSEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slides: {
      type: "array",
      description: "5 to 8 slides, in order. The first slide is the hook.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string", description: "A few words, the slide's one idea." },
          body: { type: "string", description: "One or two short sentences. Empty on a headline-only slide." },
        },
        required: ["headline", "body"],
      },
    },
    red_line_flag: { type: "string", enum: ["none", "needs_review", "rejected"] },
    red_line_reason: { type: "string", description: "Why this flag. Empty string if none." },
    edits_made: { type: "array", items: { type: "string" }, description: "Edits made to keep within the red lines." },
  },
  required: ["slides", "red_line_flag", "red_line_reason", "edits_made"],
};

export async function runCarouselAdaptation(script: string, brand: Brand): Promise<CarouselResult> {
  if (!script.trim()) throw new Error("Cannot adapt an empty script into slides.");
  return callStructured<CarouselResult>({
    system: await getEffectiveSystemPrompt(brand),
    content:
      "This time, turn the script below into an Instagram carousel instead of a reel script: 5 to 8 slides, each a short headline and a body of one or two sentences, the first slide the hook and the last the call to action. Keep the same red lines and flag the result the same way you would a script.\n\nSCRIPT:\n" +
      script,
    schema: CAROUSEL_SCHEMA,
    maxTokens: config.adaptMaxOutputTokens,
    label: "Carousel adaptation",
    tokenEnvVar: "ADAPT_MAX_OUTPUT_TOKENS",
  });
}

// --- Publish pack: caption / hashtags / cover text hook (2026-09-12) ---
//
// A SECOND, independent call rather than extra fields on runAdaptation —
// see the header of lib/publishPrompt.ts for why (token ceiling + the
// custom-prompt override trap).
//
// Manually triggered only (service.ts#generatePublishPack is reachable from
// a button, never from the scan loop), so a paid call can't fire unattended.
export async function runPublishPack(
  input: PublishPackInput
): Promise<PublishPackResult> {
  if (!input.adaptedScript.trim()) {
    throw new Error("Cannot write a publish pack for an empty script.");
  }
  return callStructured<PublishPackResult>({
    system: await getEffectivePublishSystemPrompt(input.brand),
    content: buildPublishUserMessage(input),
    schema: PUBLISH_PACK_SCHEMA,
    maxTokens: config.publishPackMaxOutputTokens,
    label: "Publish pack",
    tokenEnvVar: "PUBLISH_PACK_MAX_OUTPUT_TOKENS",
  });
}

// --- Hashtag-scan format filter (2026-08-24; per brand 2026-10-18) ---
//
// Hashtag scraping surfaces every format under a tag (skits, memes, montages,
// talking-head). This classifies a reel's cover thumbnail against the format
// the brand repurposes. Thumbnail-only (not the full video): the cover frame
// is normally enough to tell the format apart, and it's a single cheap image
// call instead of downloading and sampling video.
//
// Cyrus: one person talking to camera against an upscale background, the
// format of Taha's tracked finance accounts. Nuronomics: anything that
// carries a spoken or written explanation about Quran memorisation or
// revision — a person talking to camera in any setting, or a text-overlay
// tip slide — since its reels are rebuilt as faceless animations and only
// the script carries over. Pure recitation has no script to adapt.
const FORMAT_PROMPTS: Record<Brand, string> = {
  cyrus: `This image is the cover thumbnail of a viral Instagram Reel.

Classify whether it matches a "talking head" format: ONE individual person, clearly on camera and facing/speaking to the camera, typically set against an affluent, high-class, or luxury background (e.g. a nice office, a mansion or upscale interior, a luxury car, a rooftop skyline). This is the format used by finance and wealth-philosophy influencers.

Do NOT classify as talking head: skits or acted scenes with multiple people, text-overlay/meme slides with no visible speaker, screen recordings, b-roll/montage clips with no one speaking to camera, or group/crowd shots.

Return your answer as the required JSON.`,
  nuronomics: `This image is the cover thumbnail of a viral Instagram Reel found under a Quran-memorisation (hifz) hashtag.

Classify whether it matches an "explainer" format worth adapting: someone giving advice, a method, a story or a reminder about memorising, revising or studying the Quran. That includes ONE person speaking to the camera in any setting (home, masjid, car, classroom), or a text-overlay slide or caption card stating a tip or a hook, with or without a visible speaker.

Do NOT match: pure Quran recitation or nasheed clips (a reciter, a mushaf close-up or calligraphy with no tip or hook text), skits, memes, montages with no explanation, or content clearly about something other than Quran study.

Return your answer as the required JSON, with "matches" true for an explainer.`,
};

const FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    matches: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["matches", "reason"],
};

export interface FormatClassification {
  matches: boolean;
  reason: string;
}

function guessImageMimeType(url: string): "image/png" | "image/webp" | "image/jpeg" {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// A classification failure (fetch or model) is caught by the caller
// (lib/service.ts#scanTrackedHashtags) and treated as "skip this candidate,"
// not as a reason to abort the whole hashtag scan.
export async function classifyFormat(
  thumbnailUrl: string,
  brand: Brand
): Promise<FormatClassification> {
  if (!hasClaude()) {
    throw new Error(
      "Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set. Add one to .env.local to use hashtag discovery."
    );
  }
  const imgRes = await fetch(thumbnailUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch thumbnail (${imgRes.status}): ${thumbnailUrl}`);
  }
  const data = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

  return callStructured<FormatClassification>({
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: guessImageMimeType(thumbnailUrl), data },
      },
      { type: "text", text: FORMAT_PROMPTS[brand] },
    ],
    schema: FORMAT_SCHEMA,
    maxTokens: 2000,
    label: "Format classification",
    tokenEnvVar: "(fixed 2000 in lib/claude.ts)",
  });
}
