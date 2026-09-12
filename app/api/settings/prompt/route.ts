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
async function state(key: PromptKey) {
  const p = PROMPTS[key];
  return NextResponse.json({
    which: key,
    prompt: await p.effective(),
    default: p.default(),
    isCustom: await p.isCustom(),
  });
}

const BAD_WHICH = NextResponse.json(
  { error: "Unknown prompt — expected 'adaptation' or 'publish'." },
  { status: 400 }
);

export async function GET(request: Request) {
  const key = pick(request);
  return key ? state(key) : BAD_WHICH;
}

export async function PUT(request: Request) {
  const key = pick(request);
  if (!key) return BAD_WHICH;
  try {
    const body = await request.json();
    await PROMPTS[key].set(String(body.prompt ?? ""));
    return state(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save prompt";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const key = pick(request);
  if (!key) return BAD_WHICH;
  await PROMPTS[key].reset();
  return state(key);
}
