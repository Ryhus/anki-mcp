import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  cloneNoteType,
  cloneNoteTypeConfig,
} from "./clone-note-type.js";
import {
  getNoteTypeDesign,
  getNoteTypeDesignConfig,
} from "./get-note-type-design.js";
import {
  getNoteTypeSchema,
  getNoteTypeSchemaConfig,
} from "./get-note-type-schema.js";
import { listNoteTypes, listNoteTypesConfig } from "./list-note-types.js";
import {
  updateNoteTypeStyling,
  updateNoteTypeStylingConfig,
} from "./update-note-type-styling.js";
import {
  updateNoteTypeTemplates,
  updateNoteTypeTemplatesConfig,
} from "./update-note-type-templates.js";

/** Registers note-type discovery and design tools with the MCP server. */
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
  server.registerTool(
    "get-note-type-design",
    getNoteTypeDesignConfig,
    withToolErrorHandling(getNoteTypeDesign),
  );
  server.registerTool(
    "clone-note-type",
    cloneNoteTypeConfig,
    withToolErrorHandling(cloneNoteType),
  );
  server.registerTool(
    "update-note-type-styling",
    updateNoteTypeStylingConfig,
    withToolErrorHandling(updateNoteTypeStyling),
  );
  server.registerTool(
    "update-note-type-templates",
    updateNoteTypeTemplatesConfig,
    withToolErrorHandling(updateNoteTypeTemplates),
  );
}
