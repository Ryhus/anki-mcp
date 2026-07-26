#!/usr/bin/env node

import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCardTools } from "./tools/cards/index.js";
import { registerDeckTools } from "./tools/decks/index.js";
import { registerNoteTypeTools } from "./tools/note-types/index.js";
import { registerNoteTools } from "./tools/notes/index.js";

const server = new McpServer({
  name: "anki-mcp-server",
  version: "0.1.0",
});

registerDeckTools(server);
registerCardTools(server);
registerNoteTypeTools(server);
registerNoteTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Anki MCP server running on stdio");
}

void main().catch((error: unknown) => {
  console.error("Fatal error in main():", error);
  process.exitCode = 1;
});
