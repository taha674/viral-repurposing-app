import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bearerMatches } from "@/lib/bearer";
import { config, hasMcpToken } from "@/lib/config";
import { createMcpServer } from "@/lib/mcp/server";

// Long tools (voiceover, subtitle burn, scan) run synchronously, as they do
// in the web UI.
export const maxDuration = 600;
export const dynamic = "force-dynamic";

// Public per proxy.ts; self-authenticated with MCP_API_TOKEN. Stateless
// Streamable HTTP: one server + transport per request, JSON responses.
async function handle(request: Request): Promise<Response> {
  if (!hasMcpToken()) {
    return NextResponse.json({ error: "MCP_API_TOKEN is not configured on the server." }, { status: 500 });
  }
  if (!bearerMatches(request, config.mcpApiToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
