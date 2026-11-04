import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNotes } from "./note-loader.js";
import { toNoteDetails } from "./note-normalizers.js";
import {
  noteDetailsIdListSchema,
  noteDetailsSchema,
  noteIdSchema,
} from "./shared-schemas.js";

const getNoteDetailsInputSchema = z.object({
  noteIds: noteDetailsIdListSchema,
});

type GetNoteDetailsInput = z.infer<
  typeof getNoteDetailsInputSchema
>;

export const getNoteDetailsConfig = {
  title: "Get note details",
  description:
    "Returns complete ordered fields with per-field hashes, tags, note type, modification time, and generated card IDs. Use fields[name].hash as expectedFieldHashes[name] when updating fields.",
  inputSchema: getNoteDetailsInputSchema,
  outputSchema: z.object({
    notes: z.array(noteDetailsSchema),
    missingNoteIds: z.array(noteIdSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Returns complete normalized note data and reports missing IDs separately. */
export async function getNoteDetails({
  noteIds,
}: GetNoteDetailsInput): Promise<CallToolResult> {
  const { notes: loadedNotes, missingNoteIds } =
    await loadNotes(noteIds);
  const notes = loadedNotes.map(toNoteDetails);

  return createToolResult(
    `Returned details for ${notes.length} note${notes.length === 1 ? "" : "s"}${missingNoteIds.length === 0 ? "." : `; ${missingNoteIds.length} note ID${missingNoteIds.length === 1 ? " was" : "s were"} not found.`}`,
    { notes, missingNoteIds },
  );
}
