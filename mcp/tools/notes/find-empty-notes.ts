import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { emptyNoteCriterionSchema, findV1EmptyNotesPage } from "../../../anki-api/v1/anki-v1-note-search.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { toV1NoteSummary } from "./note-normalizers.js";
import { NOTE_SEARCH_LIMIT, noteIdSchema, noteSummarySchema } from "./shared-schemas.js";

const inputSchema = z.object({
  criterion: emptyNoteCriterionSchema.describe(
    "allFieldsEmpty checks all fields using Anki's HTML-aware emptiness; noCards finds Notes with no Cards; allQuestionsEmpty finds Notes whose possible Card questions all render empty in Anki.",
  ),
  query: z.string().max(2_000).default("").describe("Optional native Anki search to restrict the scan, e.g. tag:inbox. An empty query scans all Notes."),
  limit: z.number().int().min(1).max(NOTE_SEARCH_LIMIT).default(20).describe("Maximum candidates per page. This does not limit the initial scan."),
  cursor: z.string().min(1).max(4_096).optional().describe("Reuse nextCursor with the same criterion, query, and limit."),
});

export const findEmptyNotesConfig = {
  title: "Find empty notes",
  description: "Read-only AnkiConnect v1 scan for Notes with no Cards, empty fields, or empty questions. Returns one page of candidates for review. This tool never deletes anything.",
  inputSchema,
  outputSchema: z.object({
    criterion: emptyNoteCriterionSchema,
    query: z.string(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    notes: z.array(noteSummarySchema).max(NOTE_SEARCH_LIMIT),
    missingNoteIds: z.array(noteIdSchema).max(NOTE_SEARCH_LIMIT).describe("Matching Note IDs that could not be found when loading this page's details."),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function findEmptyNotes({
  criterion, query, limit, cursor,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const { notes: page, missingNoteIds, nextCursor } = await findV1EmptyNotesPage(criterion, query, limit, cursor);
  const notes = page.map(toV1NoteSummary);
  return createToolResult(
    `Returned ${notes.length} candidate Note${notes.length === 1 ? "" : "s"}${nextCursor === null ? "." : " with more results available."} Anki was not changed.`,
    { criterion, query, returned: notes.length, hasMore: nextCursor !== null, nextCursor, notes, missingNoteIds },
  );
}
