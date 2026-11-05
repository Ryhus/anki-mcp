import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { AnkiRequestError } from "../../../anki-api/anki-request-error.js";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { getV1NoteSearchPage } from "../../../anki-api/v1/anki-v1-note-search.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNotes } from "./note-loader.js";
import { toNoteFieldPreviews, toNoteSummary } from "./note-normalizers.js";
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
  pagination: z.enum(["offset", "cursor"]).default("offset")
    .describe("Use cursor for a native page with ANKI_API_MODE=v1; offset preserves the exact total and legacy behavior."),
  cursor: z.string().min(1).max(4_096).optional()
    .describe("Use the previous nextCursor with the same query and limit. Omit it on the first cursor page."),
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(NOTE_SEARCH_LIMIT)
    .default(20),
}).superRefine(({ pagination, cursor, offset }, context) => {
  if (cursor !== undefined && pagination !== "cursor") {
    context.addIssue({ code: "custom", path: ["cursor"], message: "cursor requires pagination: cursor" });
  }
  if (pagination === "cursor" && offset !== 0) {
    context.addIssue({ code: "custom", path: ["offset"], message: "Cursor pagination does not accept a nonzero offset" });
  }
});

type SearchNotesInput = z.infer<typeof searchNotesInputSchema>;

export const searchNotesConfig = {
  title: "Search notes",
  description:
    "Searches notes with Anki's native query syntax. Offset mode includes the exact count. With ANKI_API_MODE=v1, cursor mode returns one native page with a continuation cursor instead.",
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
  offset,
  limit,
}: SearchNotesInput): Promise<CallToolResult> {
  if (pagination === "cursor") {
    if (!useAnkiV1("notes.search")) {
      throw new AnkiRequestError(
        "configuration", "notes.search", "Cursor pagination requires ANKI_API_MODE=v1.", false,
      );
    }
    const { notes: page, missingNoteIds, nextCursor } = await getV1NoteSearchPage(query, limit, cursor);
    const notes = page.map((note) => ({
      noteId: note.id,
      modelName: note.noteType.name,
      tags: note.tags,
      fieldPreviews: toNoteFieldPreviews(Object.entries(note.fields)),
      cardIds: note.cardIds,
      modifiedAt: new Date(note.modifiedAt).toISOString(),
    }));
    return createToolResult(
      `Returned ${notes.length} matching note${notes.length === 1 ? "" : "s"}${nextCursor === null ? "." : " with more results available."}`,
      {
        query, total: null, offset: null, nextCursor, returned: notes.length,
        hasMore: nextCursor !== null, notes, missingNoteIds,
      },
    );
  }
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
