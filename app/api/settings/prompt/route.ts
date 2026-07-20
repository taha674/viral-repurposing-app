import { NextResponse } from "next/server";
import {
  getEffectiveSystemPrompt,
  getDefaultSystemPrompt,
  isSystemPromptCustomized,
  setCustomSystemPrompt,
  resetSystemPrompt,
} from "@/lib/prompt";

export async function GET() {
  return NextResponse.json({
    prompt: await getEffectiveSystemPrompt(),
    default: getDefaultSystemPrompt(),
    isCustom: await isSystemPromptCustomized(),
  });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const prompt = String(body.prompt ?? "");
    await setCustomSystemPrompt(prompt);
    return NextResponse.json({
      prompt: await getEffectiveSystemPrompt(),
      default: getDefaultSystemPrompt(),
      isCustom: await isSystemPromptCustomized(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save prompt";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  await resetSystemPrompt();
  return NextResponse.json({
    prompt: await getEffectiveSystemPrompt(),
    default: getDefaultSystemPrompt(),
    isCustom: await isSystemPromptCustomized(),
  });
}
