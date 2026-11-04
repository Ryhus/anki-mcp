import { z } from "zod";
import {
  NOTE_MUTATION_BATCH_LIMIT,
  noteFieldHashSchema,
  noteFieldValuesSchema,
  noteIdSchema,
} from "./shared-schemas.js";

const noteFieldUpdateSchema = z.object({
  noteId: noteIdSchema,
  fields: noteFieldValuesSchema.describe(
    "Partial field patch. Each submitted field replaces its complete value; other fields remain unchanged.",
  ),
  expectedFieldHashes: z
    .record(z.string().trim().min(1).max(500), noteFieldHashSchema)
    .refine((hashes) => Object.keys(hashes).length <= 100, {
      message: "At most 100 expected field hashes can be submitted",
    })
    .optional()
    .describe(
      "Expected hashes keyed by field name, from get-note-details or a dry run. Required for every submitted field when applying; unrelated fields are not checked.",
    ),
});

export const updateNoteFieldsInputSchema = z
  .object({
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
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "Preview bounded raw HTML changes and full-value hashes without modifying Anki. Set false to apply with expectedFieldHashes.",
      ),
  })
  .superRefine(({ updates, dryRun }, context) => {
    if (dryRun) {
      return;
    }

    updates.forEach(({ fields, expectedFieldHashes }, index) => {
      const hashedNames = new Set(
        Object.keys(expectedFieldHashes ?? {}).map((name) =>
          name.toLowerCase(),
        ),
      );

      for (const fieldName of Object.keys(fields)) {
        if (!hashedNames.has(fieldName.toLowerCase())) {
          context.addIssue({
            code: "custom",
            path: ["updates", index, "expectedFieldHashes", fieldName],
            message:
              "An expected hash is required for every submitted field when dryRun is false",
          });
        }
      }
    });
  });

export const noteFieldChangeSchema = z.object({
  noteId: noteIdSchema,
  fieldName: z.string(),
  changed: z.boolean(),
  beforeFieldHash: noteFieldHashSchema,
  afterFieldHash: noteFieldHashSchema,
  previousPreview: z.string(),
  proposedPreview: z.string(),
  previewTruncated: z.boolean(),
});

export const rejectedNoteFieldUpdateSchema = z.object({
  noteId: noteIdSchema,
  error: z.string(),
});

export const updateNoteFieldsOutputSchema = z.object({
  dryRun: z.boolean(),
  applied: z.boolean(),
  verified: z.boolean(),
  changedFieldCount: z.number().int().nonnegative(),
  changes: z.array(noteFieldChangeSchema),
  updatedNotes: z.array(
    z.object({
      noteId: noteIdSchema,
      updatedFields: z.array(z.string()),
    }),
  ),
  unchangedNoteIds: z.array(noteIdSchema),
  missingNoteIds: z.array(noteIdSchema),
  rejectedUpdates: z.array(rejectedNoteFieldUpdateSchema),
});

export type UpdateNoteFieldsInput = z.infer<
  typeof updateNoteFieldsInputSchema
>;
export type NoteFieldChange = z.infer<typeof noteFieldChangeSchema>;
export type RejectedNoteFieldUpdate = z.infer<
  typeof rejectedNoteFieldUpdateSchema
>;
