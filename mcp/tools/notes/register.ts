import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { createNotes, createNotesConfig } from "./create-notes.js";
import { convertNotesToNoteType, convertNotesToNoteTypeConfig } from "./convert-notes-to-note-type.js";
import {
  deleteNotesAndCards,
  deleteNotesAndCardsConfig,
} from "./delete-notes-and-cards.js";
import { editNoteTags, editNoteTagsConfig } from "./edit-note-tags.js";
import { findEmptyNotes, findEmptyNotesConfig } from "./find-empty-notes.js";
import {
  getNoteDetails,
  getNoteDetailsConfig,
} from "./get-note-details.js";
import { listTags, listTagsConfig } from "./list-tags.js";
import { replaceNoteTag, replaceNoteTagConfig } from "./replace-note-tag.js";
import { searchNotes, searchNotesConfig } from "./search-notes.js";
import {
  updateNoteFields,
  updateNoteFieldsConfig,
} from "./update-note-fields.js";
import {
  validateNoteDrafts,
  validateNoteDraftsConfig,
} from "./validate-note-drafts.js";

/** Registers the LLM-facing note tools and their schemas with the MCP server. */
export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    "search-notes",
    searchNotesConfig,
    withToolErrorHandling(searchNotes),
  );
  server.registerTool("find-empty-notes", findEmptyNotesConfig, withToolErrorHandling(findEmptyNotes));
  server.registerTool(
    "get-note-details",
    getNoteDetailsConfig,
    withToolErrorHandling(getNoteDetails),
  );
  server.registerTool(
    "validate-note-drafts",
    validateNoteDraftsConfig,
    withToolErrorHandling(validateNoteDrafts),
  );
  server.registerTool(
    "create-notes",
    createNotesConfig,
    withToolErrorHandling(createNotes),
  );
  server.registerTool(
    "update-note-fields",
    updateNoteFieldsConfig,
    withToolErrorHandling(updateNoteFields),
  );
  server.registerTool("convert-notes-to-note-type", convertNotesToNoteTypeConfig, withToolErrorHandling(convertNotesToNoteType));
  server.registerTool(
    "edit-note-tags",
    editNoteTagsConfig,
    withToolErrorHandling(editNoteTags),
  );
  server.registerTool("replace-note-tag", replaceNoteTagConfig, withToolErrorHandling(replaceNoteTag));
  server.registerTool(
    "list-tags",
    listTagsConfig,
    withToolErrorHandling(listTags),
  );
  server.registerTool(
    "delete-notes-and-cards",
    deleteNotesAndCardsConfig,
    withToolErrorHandling(deleteNotesAndCards),
  );
}
