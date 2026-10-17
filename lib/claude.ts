import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config, hasClaude } from "./config";
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
function client(): Anthropic {
  return new Anthropic({
    apiKey: config.anthropicKey,
    maxRetries: config.claudeMaxRetries,
  });
}

// One structured call, fail-loud on refusal / truncation / empty output:
// a human reviews the source rather than us retrying. `label` names the call
// and `tokenEnvVar` the knob to raise, so the operator gets an actionable
// message. `fallbacks: "default"` lets the API re-run a policy decline on its
// recommended substitute model inside the same call (still one call).
async function callStructured<T>(opts: {
  system?: string;
  content: string | BetaContentBlockParam[];
  schema: object;
  maxTokens: number;
  label: string;
  tokenEnvVar: string;
}): Promise<T> {
  if (!hasClaude()) {
    throw new Error(
      `ANTHROPIC_API_KEY is not set. Add it to .env.local to run ${opts.label.toLowerCase()}.`
    );
  }
  let response;
  try {
    response = await client().beta.messages.create({
      model: config.claudeModel,
      max_tokens: opts.maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.content }],
      output_config: {
        effort: config.claudeEffort,
        format: { type: "json_schema", schema: opts.schema as Record<string, unknown> },
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${opts.label} failed after ${config.claudeMaxRetries + 1} attempt(s): ${detail}`
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

// --- Talking-head format classifier (hashtag discovery, 2026-08-24) ---
//
// Hashtag scraping surfaces every format under a tag (skits, memes, montages,
// talking-head). This classifies a reel's cover thumbnail against the format
// Taha's tracked accounts use: one person, on camera, speaking, against an
// upscale/high-class setting. Thumbnail-only (not the full video) — the cover
// frame is normally enough to tell "person talking to camera" apart from a
// skit/meme/multi-person format, and it's a single cheap image call instead
// of downloading and sampling video.
const TALKING_HEAD_PROMPT = `This image is the cover thumbnail of a viral Instagram Reel.

Classify whether it matches a "talking head" format: ONE individual person, clearly on camera and facing/speaking to the camera, typically set against an affluent, high-class, or luxury background (e.g. a nice office, a mansion or upscale interior, a luxury car, a rooftop skyline). This is the format used by finance and wealth-philosophy influencers.

Do NOT classify as talking head: skits or acted scenes with multiple people, text-overlay/meme slides with no visible speaker, screen recordings, b-roll/montage clips with no one speaking to camera, or group/crowd shots.

Return your answer as the required JSON.`;

const TALKING_HEAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    isTalkingHead: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["isTalkingHead", "reason"],
};

export interface TalkingHeadClassification {
  isTalkingHead: boolean;
  reason: string;
}

function guessImageMimeType(url: string): "image/png" | "image/webp" | "image/jpeg" {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// A classification failure (fetch or model) is caught by the caller
// (lib/service.ts#runHashtagScan) and treated as "skip this candidate," not
// as a reason to abort the whole hashtag scan.
export async function classifyTalkingHead(
  thumbnailUrl: string
): Promise<TalkingHeadClassification> {
  if (!hasClaude()) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local to use hashtag discovery."
    );
  }
  const imgRes = await fetch(thumbnailUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch thumbnail (${imgRes.status}): ${thumbnailUrl}`);
  }
  const data = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

  return callStructured<TalkingHeadClassification>({
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: guessImageMimeType(thumbnailUrl), data },
      },
      { type: "text", text: TALKING_HEAD_PROMPT },
    ],
    schema: TALKING_HEAD_SCHEMA,
    maxTokens: 2000,
    label: "Talking-head classification",
    tokenEnvVar: "(fixed 2000 in lib/claude.ts)",
  });
}
