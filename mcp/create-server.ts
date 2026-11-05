import { McpServer } from "@modelcontextprotocol/server";
import { registerCardTools } from "./tools/cards/index.js";
import { registerDeckTools } from "./tools/decks/index.js";
import { registerMediaTools } from "./tools/media/index.js";
import { registerNoteTypeTools } from "./tools/note-types/index.js";
import { registerNoteTools } from "./tools/notes/index.js";
import { registerStatisticsTools } from "./tools/statistics/register.js";

/** Builds an independent server without starting a transport or calling Anki. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "anki-mcp-server",
    version: "0.1.0",
  });

  registerDeckTools(server);
  registerCardTools(server);
  registerNoteTypeTools(server);
  registerNoteTools(server);
  registerMediaTools(server);
  registerStatisticsTools(server);

  return server;
}
