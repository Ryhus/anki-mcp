import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerCardTools } from "./tools/cards/index.js";
import { registerDeckTools } from "./tools/decks/index.js";

const server = new McpServer({ name: "anki-mcp-server", version: "1.0.0" });

registerDeckTools(server);
registerCardTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ANKI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
