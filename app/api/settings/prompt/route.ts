import { NextResponse } from "next/server";
import {
  getEffectiveSystemPrompt,
  getDefaultSystemPrompt,
  isSystemPromptCustomized,
  setCustomSystemPrompt,
  resetSystemPrompt,
} from "@/lib/prompt";
import {
  getEffectivePublishSystemPrompt,
  getDefaultPublishSystemPrompt,
  isPublishSystemPromptCustomized,
  setCustomPublishSystemPrompt,
  resetPublishSystemPrompt,
} from "@/lib/publishPrompt";
import { parseBrand } from "@/lib/brands";
import type { Brand } from "@/lib/types";

// Two independently-overridable system prompts, one endpoint. Each has its
// own settings key, so customizing one never affects the other. `?which=`
// selects; omitting it keeps the original adaptation-only behaviour, so an
// older client (or a bookmarked URL) still works unchanged.
const PROMPTS = {
  adaptation: {
    effective: getEffectiveSystemPrompt,
    default: getDefaultSystemPrompt,
    isCustom: isSystemPromptCustomized,
    set: setCustomSystemPrompt,
    reset: resetSystemPrompt,
  },
  publish: {
    effective: getEffectivePublishSystemPrompt,
    default: getDefaultPublishSystemPrompt,
    isCustom: isPublishSystemPromptCustomized,
    set: setCustomPublishSystemPrompt,
    reset: resetPublishSystemPrompt,
  },
} as const;

type PromptKey = keyof typeof PROMPTS;

function pick(request: Request): PromptKey | null {
  const which = new URL(request.url).searchParams.get("which");
  if (!which) return "adaptation";
  return which in PROMPTS ? (which as PromptKey) : null;
}

// The same { prompt, default, isCustom } shape every verb returns, so the
// client can treat a save and a reset identically.
// Prompts are per brand (?brand=, default cyrus). A brand with no code
// default and nothing saved reads as an empty, uncustomized prompt.
async function state(key: PromptKey, brand: Brand) {
  const p = PROMPTS[key];
  const isCustom = await p.isCustom(brand);
  return NextResponse.json({
    which: key,
    brand,
    prompt: isCustom ? await p.effective(brand) : p.default(brand),
    default: p.default(brand),
    isCustom,
  });
}

function brandOf(request: Request): Brand {
  return parseBrand(new URL(request.url).searchParams.get("brand"));
}

const BAD_WHICH = NextResponse.json(
  { error: "Unknown prompt — expected 'adaptation' or 'publish'." },
  { status: 400 }
);

export async function GET(request: Request) {
  const key = pick(request);
  return key ? state(key, brandOf(request)) : BAD_WHICH;
}

export async function PUT(request: Request) {
  const key = pick(request);
  if (!key) return BAD_WHICH;
  try {
    const brand = brandOf(request);
    const body = await request.json();
    await PROMPTS[key].set(String(body.prompt ?? ""), brand);
    return state(key, brand);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save prompt";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const key = pick(request);
  if (!key) return BAD_WHICH;
  const brand = brandOf(request);
  await PROMPTS[key].reset(brand);
  return state(key, brand);
}
