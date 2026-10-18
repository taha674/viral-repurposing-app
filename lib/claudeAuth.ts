// Which credential the Claude client sends (no imports, so the harness can
// load this file directly). ANTHROPIC_AUTH_TOKEN wins and goes out as
// `Authorization: Bearer`, which is what OpenRouter's Anthropic-compatible
// endpoint expects; otherwise ANTHROPIC_API_KEY goes out as `x-api-key`
// (Anthropic direct). Never both: OpenRouter treats an x-api-key as a direct
// Anthropic credential.
export function claudeAuth(env: { apiKey: string; authToken: string }): {
  apiKey: string | null;
  authToken: string | null;
} {
  const token = env.authToken.trim();
  if (token) return { apiKey: null, authToken: token };
  const key = env.apiKey.trim();
  return { apiKey: key || null, authToken: null };
}
