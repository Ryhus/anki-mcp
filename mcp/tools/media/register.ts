import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  attachMediaToNotes,
  attachMediaToNotesConfig,
} from "./attach-media-to-notes.js";
import {
  deleteMediaFile,
  deleteMediaFileConfig,
} from "./delete-media-file.js";
import {
  detachMediaFromNotes,
  detachMediaFromNotesConfig,
} from "./detach-media-from-notes.js";
import {
  findMediaReferences,
  findMediaReferencesConfig,
} from "./find-media-references.js";
import { getMediaFile, getMediaFileConfig } from "./get-media-file.js";
import {
  searchMediaFiles,
  searchMediaFilesConfig,
} from "./search-media-files.js";
import {
  storeMediaFile,
  storeMediaFileConfig,
} from "./store-media-file.js";

/** Registers bounded file lifecycle and safe note-reference Media tools. */
export function registerMediaTools(server: McpServer): void {
  server.registerTool(
    "search-media-files",
    searchMediaFilesConfig,
    withToolErrorHandling(searchMediaFiles),
  );
  server.registerTool(
    "get-media-file",
    getMediaFileConfig,
    withToolErrorHandling(getMediaFile),
  );
  server.registerTool(
    "store-media-file",
    storeMediaFileConfig,
    withToolErrorHandling(storeMediaFile),
  );
  server.registerTool(
    "find-media-references",
    findMediaReferencesConfig,
    withToolErrorHandling(findMediaReferences),
  );
  server.registerTool(
    "attach-media-to-notes",
    attachMediaToNotesConfig,
    withToolErrorHandling(attachMediaToNotes),
  );
  server.registerTool(
    "detach-media-from-notes",
    detachMediaFromNotesConfig,
    withToolErrorHandling(detachMediaFromNotes),
  );
  server.registerTool(
    "delete-media-file",
    deleteMediaFileConfig,
    withToolErrorHandling(deleteMediaFile),
  );
}
