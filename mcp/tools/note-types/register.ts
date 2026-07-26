import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  addNoteTypeField,
  addNoteTypeFieldConfig,
} from "./add-note-type-field.js";
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
  renameNoteTypeField,
  renameNoteTypeFieldConfig,
} from "./rename-note-type-field.js";
import {
  repositionNoteTypeField,
  repositionNoteTypeFieldConfig,
} from "./reposition-note-type-field.js";
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
    "add-note-type-field",
    addNoteTypeFieldConfig,
    withToolErrorHandling(addNoteTypeField),
  );
  server.registerTool(
    "rename-note-type-field",
    renameNoteTypeFieldConfig,
    withToolErrorHandling(renameNoteTypeField),
  );
  server.registerTool(
    "reposition-note-type-field",
    repositionNoteTypeFieldConfig,
    withToolErrorHandling(repositionNoteTypeField),
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
