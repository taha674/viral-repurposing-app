import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";

const INSTRUCTIONS =
  "Controls for the Cyrus Amin viral-repurposing pipeline: discovery → accept → red-line adaptation → approval → voiceover → video → subtitle burn → publish-pack suggestions. " +
  "Begin with get_pipeline_overview; get_reel returns allowed_actions for what is legal next. " +
  "Paid tools (adapt, voiceover, publish pack, transcript, scan) are one call = one generation: never retry a failure in a loop, report it. " +
  "When in doubt about an approval, ask the operator on Telegram. Nothing here posts to Instagram — the operator writes and posts the final caption.";

// Stateless: a fresh server per request (the transport is stateless too), so
// there is no session state to lose across Railway restarts.
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "cyrus-reels", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}
