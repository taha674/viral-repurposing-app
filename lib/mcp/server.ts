import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";

const INSTRUCTIONS =
  "Controls the content board for two brands, Cyrus Amin (cyrus) and Nuronomics (nuronomics): discovery → accept → red-line adaptation → approval → voiceover → video → subtitle burn → publish-pack suggestions → schedule → posted, plus originals, carousels, stories, text posts, an engagement queue and metrics. Pass `brand` where a tool takes it; never assume an item is Cyrus's. " +
  "Begin with get_operator_queue or get_pipeline_overview; get_reel returns allowed_actions for what is legal next. " +
  "Paid tools (adapt, voiceover, publish pack, transcript, scan) are one call = one generation: never retry a failure in a loop, report it. " +
  "Every approval (needs_review scripts, approve_item, approve_engagement, mark_posted, publish_to_instagram, archive_reel) needs the operator's quoted Telegram reply; when in doubt, ask. " +
  "The only tool that posts is publish_to_instagram: Nuronomics Instagram only, a scheduled item, after the operator approved that exact post. Everything else (Cyrus, other platforms, replies, comments, DMs) the operator posts or sends by hand.";

// Stateless: a fresh server per request (the transport is stateless too), so
// there is no session state to lose across Railway restarts.
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "cyrus-reels", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}
