import { z } from "zod";
import {
  NOTE_BATCH_LIMIT,
  noteDraftSchema,
  noteDraftValidationSchema,
  noteIdSchema,
} from "./shared-schemas.js";

export const noteCreationInputSchema = z.object({
  notes: z.array(noteDraftSchema).min(1).max(NOTE_BATCH_LIMIT)
    .describe("One or more notes to validate and create as one batch"),
});

const inputIndexSchema = z.number().int().nonnegative();
export const createdCardIdsSchema = z.array(z.number().int().positive())
  .refine((ids) => new Set(ids).size === ids.length, "Card IDs must be distinct");

const verifiedCreationSchema = z.object({
  inputIndex: inputIndexSchema,
  status: z.literal("created"),
  noteId: noteIdSchema,
  cardIds: createdCardIdsSchema,
  error: z.null(),
});
const unverifiedCreationSchema = verifiedCreationSchema.extend({
  status: z.literal("created-unverified"),
  cardIds: z.null(),
  error: z.string(),
});
const unsuccessfulCreationSchema = z.object({
  inputIndex: inputIndexSchema,
  status: z.enum(["not-created", "not-attempted", "unknown"]),
  noteId: z.null(),
  cardIds: z.null(),
  error: z.string(),
});

export const noteCreationResultSchema = z.union([
  verifiedCreationSchema, unverifiedCreationSchema, unsuccessfulCreationSchema,
]);

export const noteCreationOutputSchema = z.object({
  outcome: z.enum(["complete", "incomplete", "unknown", "not-attempted"]),
  createdNoteCount: z.number().int().nonnegative().nullable()
    .describe("Exact acknowledged count when every creation outcome is known; null if any outcome is unknown"),
  createdNotes: z.array(z.object({
    inputIndex: inputIndexSchema,
    noteId: noteIdSchema,
    cardIds: createdCardIdsSchema.nullable()
      .describe("null means readback was unavailable/untrusted, not that the Note has no Cards"),
    verified: z.boolean(),
  })),
  noteResults: z.array(noteCreationResultSchema),
  reportedNoteIds: z.array(noteIdSchema).max(NOTE_BATCH_LIMIT)
    .describe("Distinct IDs reported by AnkiConnect, including unmapped IDs from malformed replies; not proof of ownership or creation"),
  reportedNoteIdsTruncated: z.boolean(),
  validations: z.array(noteDraftValidationSchema),
  warnings: z.array(z.string()),
});

export type NoteCreationInput = z.infer<typeof noteCreationInputSchema>;
export type NoteCreationResult = z.infer<typeof noteCreationResultSchema>;
export type NoteCreationOutput = z.infer<typeof noteCreationOutputSchema>;
