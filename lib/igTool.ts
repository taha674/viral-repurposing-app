// Which treg own-tool publish_to_instagram calls (no imports, so the harness
// can load this file directly). There is deliberately no default: on treg,
// `instagram` is @thecyrusamin and `instagram-2` is the hifz account
// @surahwise, so a fallback could post a Nuronomics item to Cyrus's account.
export function igPublishTool(configured: string): string {
  const tool = configured.trim();
  if (!tool) {
    throw new Error(
      "INSTAGRAM_PUBLISH_TREG_TOOL is not set. Set it to the treg tool of the Nuronomics (hifz) account, e.g. instagram-2; nothing was published."
    );
  }
  return tool;
}

// The account the tool is connected to must be the one we expect.
export function checkPublishAccount(username: string | undefined, expected: string): void {
  if (!expected.trim()) throw new Error("INSTAGRAM_PUBLISH_USERNAME is not set; nothing was published.");
  if ((username ?? "").toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`The publish tool is connected to @${username ?? "unknown"}, not @${expected}. Nothing was published.`);
  }
}
