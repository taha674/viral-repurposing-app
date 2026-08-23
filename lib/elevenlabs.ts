import { config, hasElevenLabs } from "./config";
import type { VoiceoverAlignment } from "./types";

// Only transient transport/quota failures are worth a second attempt.
// Auth/validation failures are deterministic — retrying just burns quota.
// Same shape as gemini.ts's isRetryable, applied here to fetch() responses.
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ECONNRESET|ETIMEDOUT|fetch failed|abort/i.test(message);
}

// Generates narration audio for the given text using the fixed Cyrus v4
// voice. ElevenLabs' text-to-speech endpoint is a single synchronous HTTP
// call (not an async job) — there's no job status to poll. Reliability is
// handled via a request timeout plus a hard-capped retry-on-transient-error
// loop (ELEVENLABS_MAX_RETRIES is a HARD CAP — never loop silently against a
// paid API; failures surface to the operator).
export async function generateVoiceover(text: string): Promise<Buffer> {
  if (!hasElevenLabs()) {
    throw new Error(
      "ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set. Add them to .env.local to generate a voiceover."
    );
  }
  if (!text.trim()) {
    throw new Error("Cannot generate a voiceover from an empty script.");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabsVoiceId}`;
  const attempts = Math.max(1, config.elevenlabsMaxRetries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.elevenlabsTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": config.elevenlabsKey,
        },
        body: JSON.stringify({
          text,
          model_id: config.elevenlabsModelId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const err = new Error(
          `ElevenLabs request failed (${response.status}): ${detail.slice(0, 300)}`
        ) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Voiceover generation failed after ${attempts} attempt(s): ${detail}`);
}

export interface VoiceoverWithAlignment {
  audio: Buffer;
  alignment: VoiceoverAlignment;
}

// Same generation call as generateVoiceover, but via the with-timestamps
// endpoint: ElevenLabs returns character-level alignment alongside the
// audio in one request, at no extra cost. This is the source of truth for
// caption timing — exact, since it's the same TTS render, not a re-guess
// via speech recognition on the output audio.
export async function generateVoiceoverWithTimestamps(
  text: string
): Promise<VoiceoverWithAlignment> {
  if (!hasElevenLabs()) {
    throw new Error(
      "ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set. Add them to .env.local to generate a voiceover."
    );
  }
  if (!text.trim()) {
    throw new Error("Cannot generate a voiceover from an empty script.");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabsVoiceId}/with-timestamps`;
  const attempts = Math.max(1, config.elevenlabsMaxRetries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.elevenlabsTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": config.elevenlabsKey,
        },
        body: JSON.stringify({
          text,
          model_id: config.elevenlabsModelId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const err = new Error(
          `ElevenLabs request failed (${response.status}): ${detail.slice(0, 300)}`
        ) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      const data = (await response.json()) as {
        audio_base64: string;
        alignment: VoiceoverAlignment | null;
      };
      if (!data.audio_base64 || !data.alignment) {
        throw new Error("ElevenLabs response missing audio_base64 or alignment.");
      }
      return {
        audio: Buffer.from(data.audio_base64, "base64"),
        alignment: data.alignment,
      };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Voiceover generation failed after ${attempts} attempt(s): ${detail}`);
}
