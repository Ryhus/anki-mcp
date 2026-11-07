import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { getV1NoteSearchPage } from "../../../anki-api/v1/anki-v1-note-search.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { resolveSearchPagination, searchPaginationShape, validateSearchPagination } from "../../utils/search-pagination.js";
import { loadNotes } from "./note-loader.js";
import { toNoteSummary, toV1NoteSummary } from "./note-normalizers.js";
import {
  NOTE_SEARCH_LIMIT,
  noteIdSchema,
  noteSummarySchema,
} from "./shared-schemas.js";

const searchNotesInputSchema = z.object({
  query: z
    .string()
    .max(2_000)
    .describe(
      'Native Anki search query, for example "deck:German tag:A1", "note:Basic", or "Front:*Hund*". An empty query searches all notes.',
    ),
  ...searchPaginationShape,
  limit: z
    .number()
    .int()
    .min(1)
    .max(NOTE_SEARCH_LIMIT)
    .default(20),
}).superRefine(validateSearchPagination);

type SearchNotesInput = z.infer<typeof searchNotesInputSchema>;

export const searchNotesConfig = {
  title: "Search notes",
  description:
    "Searches notes with Anki's native query syntax. In v1 mode, defaults to a native page with a continuation cursor. Request pagination: offset for an exact total or a numeric position.",
  inputSchema: searchNotesInputSchema,
  outputSchema: z.object({
    query: z.string(),
    total: z.number().int().nonnegative().nullable().describe("Exact count in offset mode; null in cursor mode."),
    offset: z.number().int().nonnegative().nullable().describe("Offset used in legacy mode; null in cursor mode."),
    nextCursor: z.string().nullable().optional().describe("Present in cursor mode. Null means the search is complete."),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    notes: z.array(noteSummarySchema),
    missingNoteIds: z.array(noteIdSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Searches notes without allowing a large collection to flood MCP context. */
export async function searchNotes({
  query,
  pagination,
  cursor,
  offset: requestedOffset,
  limit,
}: SearchNotesInput): Promise<CallToolResult> {
  const mode = resolveSearchPagination({ pagination, cursor, offset: requestedOffset }, "notes.search");
  if (mode === "cursor") {
    const { notes: page, missingNoteIds, nextCursor } = await getV1NoteSearchPage(query, limit, cursor);
    const notes = page.map(toV1NoteSummary);
    return createToolResult(
      `Returned ${notes.length} matching note${notes.length === 1 ? "" : "s"}${nextCursor === null ? "." : " with more results available."}`,
      {
        query, total: null, offset: null, nextCursor, returned: notes.length,
        hasMore: nextCursor !== null, notes, missingNoteIds,
      },
    );
  }
  const offset = requestedOffset ?? 0;
  const matchingNoteIds = await findAnkiNotes(query);
  const pageNoteIds = matchingNoteIds.slice(offset, offset + limit);
  const { notes: loadedNotes, missingNoteIds } =
    await loadNotes(pageNoteIds);
  const notes = loadedNotes.map(toNoteSummary);
  const hasMore = offset + pageNoteIds.length < matchingNoteIds.length;

  return createToolResult(
    `Found ${matchingNoteIds.length} matching note${matchingNoteIds.length === 1 ? "" : "s"}; returned ${notes.length} from offset ${offset}${hasMore ? " with more results available" : ""}.`,
    {
      query,
      total: matchingNoteIds.length,
      offset,
      returned: notes.length,
      hasMore,
      notes,
      missingNoteIds,
    },
  );
}
