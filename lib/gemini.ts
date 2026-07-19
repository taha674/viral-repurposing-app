import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { config, hasGemini } from "./config";
import {
  getEffectiveSystemPrompt,
  buildUserMessage,
  ADAPTATION_SCHEMA,
  type AdaptationResult,
} from "./prompt";

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

function extractResult(response: GenerateContentResponse): AdaptationResult {
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
      "Adaptation output was truncated (hit maxOutputTokens). Raise ADAPT_MAX_OUTPUT_TOKENS."
    );
  }

  const text = response.text?.trim();
  if (!text) throw new Error("Adaptation returned no text output.");

  try {
    return JSON.parse(text) as AdaptationResult;
  } catch {
    throw new Error(
      "Adaptation output was not valid JSON. Raw output: " + text.slice(0, 300)
    );
  }
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
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: buildUserMessage(transcript),
        config: {
          systemInstruction: getEffectiveSystemPrompt(),
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
