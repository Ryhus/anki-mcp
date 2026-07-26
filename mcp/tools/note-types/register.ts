import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  getNoteTypeSchema,
  getNoteTypeSchemaConfig,
} from "./get-note-type-schema.js";
import { listNoteTypes, listNoteTypesConfig } from "./list-note-types.js";

/** Registers note-type discovery tools with the MCP server. */
export function registerNoteTypeTools(server: McpServer): void {
  server.registerTool(
    "list-note-types",
    listNoteTypesConfig,
    withToolErrorHandling(listNoteTypes),
  );
  server.registerTool(
    "get-note-type-schema",
    getNoteTypeSchemaConfig,
    withToolErrorHandling(getNoteTypeSchema),
  );
}
