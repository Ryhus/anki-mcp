import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNotes } from "./note-loader.js";
import { toNoteSummary } from "./note-normalizers.js";
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
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(NOTE_SEARCH_LIMIT)
    .default(20),
});

type SearchNotesInput = z.infer<typeof searchNotesInputSchema>;

export const searchNotesConfig = {
  title: "Search notes",
  description:
    "Searches notes with Anki's native query syntax and returns a bounded page with field previews, tags, and generated card IDs.",
  inputSchema: searchNotesInputSchema,
  outputSchema: z.object({
    query: z.string(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
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
  offset,
  limit,
}: SearchNotesInput): Promise<CallToolResult> {
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
