import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deleteAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNotes } from "./note-loader.js";
import {
  noteIdSchema,
  noteMutationIdListSchema,
} from "./shared-schemas.js";

const deleteNotesAndCardsInputSchema = z.object({
  noteIds: noteMutationIdListSchema.describe(
    "Explicit note IDs to permanently delete. Search queries are intentionally not accepted.",
  ),
});

type DeleteNotesAndCardsInput = z.infer<
  typeof deleteNotesAndCardsInputSchema
>;

const deletedNoteSchema = z.object({
  noteId: noteIdSchema,
  deletedCardIds: z.array(z.number().int().positive()),
});

export const deleteNotesAndCardsConfig = {
  title: "Delete notes and cards",
  description:
    "Permanently deletes explicitly selected notes and every card generated from them. Missing note IDs are reported separately.",
  inputSchema: deleteNotesAndCardsInputSchema,
  outputSchema: z.object({
    deletedNotes: z.array(deletedNoteSchema),
    missingNoteIds: z.array(noteIdSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Deletes only validated existing notes and reports their affected card IDs. */
export async function deleteNotesAndCards({
  noteIds,
}: DeleteNotesAndCardsInput): Promise<CallToolResult> {
  const { notes, missingNoteIds } = await loadNotes(noteIds);
  const existingNoteIds = notes.map(({ noteId }) => noteId);
  const deletedNotes = notes.map((note) => ({
    noteId: note.noteId,
    deletedCardIds: note.cards,
  }));

  if (existingNoteIds.length > 0) {
    await deleteAnkiNotes(existingNoteIds);
  }

  const deletedCardCount = deletedNotes.reduce(
    (total, note) => total + note.deletedCardIds.length,
    0,
  );

  return createToolResult(
    `Deleted ${deletedNotes.length} note${deletedNotes.length === 1 ? "" : "s"} and ${deletedCardCount} associated card${deletedCardCount === 1 ? "" : "s"}; ${missingNoteIds.length} note ID${missingNoteIds.length === 1 ? " was" : "s were"} not found.`,
    { deletedNotes, missingNoteIds },
  );
}
