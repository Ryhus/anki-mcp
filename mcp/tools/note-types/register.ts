import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  addNoteTypeField,
  addNoteTypeFieldConfig,
} from "./add-note-type-field.js";
import {
  addNoteTypeTemplate,
  addNoteTypeTemplateConfig,
} from "./add-note-type-template.js";
import {
  cloneNoteType,
  cloneNoteTypeConfig,
} from "./clone-note-type.js";
import {
  createNoteType,
  createNoteTypeConfig,
} from "./create-note-type.js";
import {
  deleteNoteTypeField,
  deleteNoteTypeFieldConfig,
} from "./delete-note-type-field.js";
import {
  deleteNoteTypeTemplate,
  deleteNoteTypeTemplateConfig,
} from "./delete-note-type-template.js";
import { deleteUnusedNoteType, deleteUnusedNoteTypeConfig } from "./delete-unused-note-type.js";
import {
  getNoteTypeDesign,
  getNoteTypeDesignConfig,
} from "./get-note-type-design.js";
import {
  getNoteTypeSchema,
  getNoteTypeSchemaConfig,
} from "./get-note-type-schema.js";
import { listNoteTypes, listNoteTypesConfig } from "./list-note-types.js";
import { renameNoteType, renameNoteTypeConfig } from "./rename-note-type.js";
import {
  renameNoteTypeField,
  renameNoteTypeFieldConfig,
} from "./rename-note-type-field.js";
import {
  renameNoteTypeTemplate,
  renameNoteTypeTemplateConfig,
} from "./rename-note-type-template.js";
import {
  repositionNoteTypeField,
  repositionNoteTypeFieldConfig,
} from "./reposition-note-type-field.js";
import {
  repositionNoteTypeTemplate,
  repositionNoteTypeTemplateConfig,
} from "./reposition-note-type-template.js";
import { setNoteTypeSortField, setNoteTypeSortFieldConfig } from "./set-note-type-sort-field.js";
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
    withToolErrorHandling(listNoteTypes, false),
  );
  server.registerTool(
    "get-note-type-schema",
    getNoteTypeSchemaConfig,
    withToolErrorHandling(getNoteTypeSchema),
  );
  server.registerTool(
    "get-note-type-design",
    getNoteTypeDesignConfig,
    withToolErrorHandling(getNoteTypeDesign, false),
  );
  server.registerTool(
    "clone-note-type",
    cloneNoteTypeConfig,
    withToolErrorHandling(cloneNoteType),
  );
  server.registerTool(
    "create-note-type",
    createNoteTypeConfig,
    withToolErrorHandling(createNoteType),
  );
  server.registerTool(
    "rename-note-type",
    renameNoteTypeConfig,
    withToolErrorHandling(renameNoteType),
  );
  server.registerTool(
    "set-note-type-sort-field",
    setNoteTypeSortFieldConfig,
    withToolErrorHandling(setNoteTypeSortField),
  );
  server.registerTool(
    "delete-unused-note-type",
    deleteUnusedNoteTypeConfig,
    withToolErrorHandling(deleteUnusedNoteType),
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
    "delete-note-type-field",
    deleteNoteTypeFieldConfig,
    withToolErrorHandling(deleteNoteTypeField),
  );
  server.registerTool(
    "add-note-type-template",
    addNoteTypeTemplateConfig,
    withToolErrorHandling(addNoteTypeTemplate),
  );
  server.registerTool(
    "rename-note-type-template",
    renameNoteTypeTemplateConfig,
    withToolErrorHandling(renameNoteTypeTemplate),
  );
  server.registerTool(
    "reposition-note-type-template",
    repositionNoteTypeTemplateConfig,
    withToolErrorHandling(repositionNoteTypeTemplate),
  );
  server.registerTool(
    "delete-note-type-template",
    deleteNoteTypeTemplateConfig,
    withToolErrorHandling(deleteNoteTypeTemplate),
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
