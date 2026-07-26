import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { updateAnkiNoteFields } from "../../../anki-api/notes/note-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { canonicalizeFields } from "./note-field-utils.js";
import { loadNotes } from "./note-loader.js";
import {
  NOTE_MUTATION_BATCH_LIMIT,
  noteFieldValuesSchema,
  noteIdSchema,
} from "./shared-schemas.js";

const noteFieldUpdateSchema = z.object({
  noteId: noteIdSchema,
  fields: noteFieldValuesSchema.describe(
    "Partial field patch. Unspecified fields remain unchanged.",
  ),
});

const updateNoteFieldsInputSchema = z.object({
  updates: z
    .array(noteFieldUpdateSchema)
    .min(1)
    .max(NOTE_MUTATION_BATCH_LIMIT)
    .refine(
      (updates) =>
        new Set(updates.map(({ noteId }) => noteId)).size ===
        updates.length,
      { message: "Each note ID can appear only once in an update batch" },
    ),
});

type UpdateNoteFieldsInput = z.infer<
  typeof updateNoteFieldsInputSchema
>;

const updatedNoteSchema = z.object({
  noteId: noteIdSchema,
  updatedFields: z.array(z.string()),
});

const rejectedUpdateSchema = z.object({
  noteId: noteIdSchema,
  error: z.string(),
});

export const updateNoteFieldsConfig = {
  title: "Update note fields",
  description:
    "Applies partial field patches to existing notes. All note IDs and field names are validated before any field is changed.",
  inputSchema: updateNoteFieldsInputSchema,
  outputSchema: z.object({
    applied: z.boolean(),
    updatedNotes: z.array(updatedNoteSchema),
    unchangedNoteIds: z.array(noteIdSchema),
    missingNoteIds: z.array(noteIdSchema),
    rejectedUpdates: z.array(rejectedUpdateSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Validates a complete batch before overwriting any note field values. */
export async function updateNoteFields({
  updates,
}: UpdateNoteFieldsInput): Promise<CallToolResult> {
  const { notes, missingNoteIds } = await loadNotes(
    updates.map(({ noteId }) => noteId),
  );
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const preparedUpdates: Array<{
    noteId: number;
    fields: Record<string, string>;
    updatedFields: string[];
  }> = [];
  const unchangedNoteIds: number[] = [];
  const rejectedUpdates: Array<{ noteId: number; error: string }> = [];

  for (const update of updates) {
    const note = notesById.get(update.noteId);

    if (note === undefined) {
      continue;
    }

    const canonicalFields = canonicalizeFields(
      update.fields,
      Object.keys(note.fields),
    );

    if (typeof canonicalFields === "string") {
      rejectedUpdates.push({
        noteId: update.noteId,
        error: canonicalFields,
      });
      continue;
    }

    const changedFields = Object.entries(canonicalFields).filter(
      ([name, value]) => note.fields[name]?.value !== value,
    );

    if (changedFields.length === 0) {
      unchangedNoteIds.push(update.noteId);
      continue;
    }

    preparedUpdates.push({
      noteId: update.noteId,
      fields: Object.fromEntries(changedFields),
      updatedFields: changedFields.map(([name]) => name),
    });
  }

  if (missingNoteIds.length > 0 || rejectedUpdates.length > 0) {
    return createToolResult(
      `Applied no field updates because ${missingNoteIds.length} note ID${missingNoteIds.length === 1 ? " was" : "s were"} missing and ${rejectedUpdates.length} update${rejectedUpdates.length === 1 ? " was" : "s were"} invalid.`,
      {
        applied: false,
        updatedNotes: [],
        unchangedNoteIds,
        missingNoteIds,
        rejectedUpdates,
      },
    );
  }

  for (const update of preparedUpdates) {
    await updateAnkiNoteFields({
      id: update.noteId,
      fields: update.fields,
    });
  }

  const updatedNotes = preparedUpdates.map(
    ({ noteId, updatedFields }) => ({ noteId, updatedFields }),
  );

  return createToolResult(
    `Updated ${updatedNotes.length} note${updatedNotes.length === 1 ? "" : "s"}; ${unchangedNoteIds.length} already contained the requested field values.`,
    {
      applied: true,
      updatedNotes,
      unchangedNoteIds,
      missingNoteIds: [],
      rejectedUpdates: [],
    },
  );
}
