import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { config, hasGemini } from "./config";
import {
  getEffectiveSystemPrompt,
  buildUserMessage,
  ADAPTATION_SCHEMA,
  type AdaptationResult,
} from "./prompt";
import {
  getEffectivePublishSystemPrompt,
  buildPublishUserMessage,
  PUBLISH_PACK_SCHEMA,
  type PublishPackInput,
  type PublishPackResult,
} from "./publishPrompt";

// Finish reasons that mean the model refused / was blocked rather than answered.
// Treated as fail-loud: a human reviews the source instead of us retrying.
const BLOCKED_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
]);

// Only transient transport/quota failures are worth a second attempt. Schema,
// auth, and refusal failures are deterministic — retrying just burns quota.
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

// Refusal / truncation / empty-output guards, shared by every structured
// call. Fail-loud in all three cases: a human reviews the source rather than
// us retrying (a refusal is deterministic, and a retry just burns quota).
// `label` names the call and `tokenEnvVar` the knob to raise, so the operator
// gets an actionable message instead of a generic one.
function parseStructured<T>(
  response: GenerateContentResponse,
  label: string,
  tokenEnvVar: string
): T {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(
      `The model blocked this request (${blockReason}). Review the source manually.`
    );
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && BLOCKED_REASONS.has(finishReason)) {
    throw new Error(
      `The model declined this request (${finishReason}). Review the source manually.`
    );
  }
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      `${label} output was truncated (hit maxOutputTokens). Raise ${tokenEnvVar}.`
    );
  }

  const text = response.text?.trim();
  if (!text) throw new Error(`${label} returned no text output.`);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${label} output was not valid JSON. Raw output: ` + text.slice(0, 300)
    );
  }
}

function extractResult(response: GenerateContentResponse): AdaptationResult {
  return parseStructured<AdaptationResult>(
    response,
    "Adaptation",
    "ADAPT_MAX_OUTPUT_TOKENS"
  );
}

// Runs the red-line-compliance adaptation prompt against Gemini.
// responseJsonSchema + responseMimeType guarantee schema-valid JSON.
// Thinking is disabled (thinkingBudget 0): this is a scoped extraction/edit
// task and we want deterministic structured output in a small token budget.
// GEMINI_MAX_RETRIES is a HARD CAP (project rule: never loop silently
// against a paid API — failures surface to the operator).
export async function runAdaptation(
  transcript: string
): Promise<AdaptationResult> {
  if (!hasGemini()) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local to run adaptation."
    );
  }
  if (!transcript.trim()) {
    throw new Error("Cannot adapt an empty transcript.");
  }

  const ai = new GoogleGenAI({ apiKey: config.geminiKey });
  const attempts = Math.max(1, config.geminiMaxRetries + 1);
  const systemInstruction = await getEffectiveSystemPrompt();
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: buildUserMessage(transcript),
        config: {
          systemInstruction,
          maxOutputTokens: config.adaptMaxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseJsonSchema: ADAPTATION_SCHEMA,
        },
      });
      return extractResult(response);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Adaptation failed after ${attempts} attempt(s): ${detail}`);
}

// --- Publish pack: caption / hashtags / cover text hook (2026-09-12) ---
//
// A SECOND, independent call rather than extra fields on runAdaptation —
// see the header of lib/publishPrompt.ts for why (token ceiling + the
// custom-prompt override trap). Same hard cap, same fail-loud handling, same
// thinkingBudget 0: this is scoped writing against an explicit rubric, not a
// reasoning task.
//
// Manually triggered only (service.ts#generatePublishPack is reachable from
// a button, never from the scan loop), so a paid call can't fire unattended.
export async function runPublishPack(
  input: PublishPackInput
): Promise<PublishPackResult> {
  if (!hasGemini()) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local to generate a publish pack."
    );
  }
  if (!input.adaptedScript.trim()) {
    throw new Error("Cannot write a publish pack for an empty script.");
  }

  const ai = new GoogleGenAI({ apiKey: config.geminiKey });
  const attempts = Math.max(1, config.geminiMaxRetries + 1);
  const systemInstruction = await getEffectivePublishSystemPrompt();
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: buildPublishUserMessage(input),
        config: {
          systemInstruction,
          maxOutputTokens: config.publishPackMaxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseJsonSchema: PUBLISH_PACK_SCHEMA,
        },
      });
      return parseStructured<PublishPackResult>(
        response,
        "Publish pack",
        "PUBLISH_PACK_MAX_OUTPUT_TOKENS"
      );
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Publish pack failed after ${attempts} attempt(s): ${detail}`);
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

function guessImageMimeType(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// GEMINI_MAX_RETRIES is the same hard cap used by runAdaptation — never loop
// silently against a paid API. A classification failure (fetch or model) is
// caught by the caller (lib/service.ts#runHashtagScan) and treated as "skip
// this candidate," not as a reason to abort the whole hashtag scan.
export async function classifyTalkingHead(
  thumbnailUrl: string
): Promise<TalkingHeadClassification> {
  if (!hasGemini()) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local to use hashtag discovery."
    );
  }

  const imgRes = await fetch(thumbnailUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch thumbnail (${imgRes.status}): ${thumbnailUrl}`);
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mimeType = guessImageMimeType(thumbnailUrl);

  const ai = new GoogleGenAI({ apiKey: config.geminiKey });
  const attempts = Math.max(1, config.geminiMaxRetries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: [
          { inlineData: { mimeType, data: buf.toString("base64") } },
          { text: TALKING_HEAD_PROMPT },
        ],
        config: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseJsonSchema: TALKING_HEAD_SCHEMA,
        },
      });
      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(`The model blocked this request (${blockReason}).`);
      }
      const text = response.text?.trim();
      if (!text) throw new Error("Classifier returned no text output.");
      return JSON.parse(text) as TalkingHeadClassification;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Talking-head classification failed after ${attempts} attempt(s): ${detail}`);
}
