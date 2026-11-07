import { z } from "zod";
import { noteMediaReferenceSchema } from "../media/shared-schemas.js";

export const NOTE_BATCH_LIMIT = 50;
export const NOTE_DETAILS_BATCH_LIMIT = 20;
export const NOTE_MUTATION_BATCH_LIMIT = 50;
export const NOTE_TAG_BATCH_LIMIT = 100;
export const NOTE_SEARCH_LIMIT = 100;

export const noteIdSchema = z
  .number()
  .int()
  .positive()
  .describe("Anki note ID");

export const noteDetailsIdListSchema = z
  .array(noteIdSchema)
  .min(1)
  .max(NOTE_DETAILS_BATCH_LIMIT)
  .describe(
    `One to ${NOTE_DETAILS_BATCH_LIMIT} note IDs whose complete fields and metadata should be returned`,
  );

export const noteMutationIdListSchema = z
  .array(noteIdSchema)
  .min(1)
  .max(NOTE_TAG_BATCH_LIMIT)
  .describe(`One to ${NOTE_TAG_BATCH_LIMIT} Anki note IDs`);

export const modelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    'Anki note type name. AnkiConnect calls note types "models" in its API.',
  );

export const deckNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .describe(
    'Full target deck name. Use "::" between parent and child deck names.',
  );

export const noteTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^\S+$/, "Anki tags cannot contain whitespace");

export const noteTagListSchema = z.array(noteTagSchema).max(100);

export const noteFieldValuesSchema = z
  .record(
    z.string().trim().min(1).max(500),
    z.string().max(500_000),
  )
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "At least one note field is required",
  })
  .refine((fields) => Object.keys(fields).length <= 100, {
    message: "A note cannot contain more than 100 submitted fields",
  });

export const noteDraftOptionsSchema = z.object({
  allowDuplicate: z
    .boolean()
    .default(false)
    .describe("Allow Anki to create a duplicate note"),
  duplicateScope: z
    .enum(["collection", "deck"])
    .default("collection")
    .describe("Collection-wide or deck-scoped duplicate checking"),
  duplicateScopeDeckName: deckNameSchema
    .optional()
    .describe(
      "Deck used for duplicate checking when duplicateScope is deck. Defaults to the target deck.",
    ),
  checkChildren: z
    .boolean()
    .default(false)
    .describe("Include child decks in deck-scoped duplicate checking"),
  checkAllModels: z
    .boolean()
    .default(false)
    .describe("Check duplicates across all note types"),
});

export const noteDraftSchema = z.object({
  deckName: deckNameSchema,
  modelName: modelNameSchema,
  fields: noteFieldValuesSchema,
  mediaReferences: z
    .array(noteMediaReferenceSchema)
    .max(20)
    .default([])
    .describe(
      "References to media files that already exist in Anki; references are safely merged into the selected fields before validation and creation",
    ),
  tags: noteTagListSchema.default([]),
  options: noteDraftOptionsSchema.default({
    allowDuplicate: false,
    duplicateScope: "collection",
    checkChildren: false,
    checkAllModels: false,
  }),
});

export const noteFieldHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 field hash")
  .describe("SHA-256 of the complete UTF-8 field value, including HTML");

export const noteFieldSchema = z.object({
  value: z.string(),
  order: z.number().int().nonnegative(),
  hash: noteFieldHashSchema,
});

export const noteSummarySchema = z.object({
  noteId: noteIdSchema,
  modelName: z.string().describe("Anki note type name"),
  tags: z.array(z.string()),
  fieldPreviews: z.record(z.string(), z.string()),
  cardIds: z.array(
    z.number().int().positive().describe("Card generated from the note"),
  ),
  modifiedAt: z
    .string()
    .describe("Note modification time as an ISO 8601 timestamp"),
});

export const noteDetailsSchema = z.object({
  noteId: noteIdSchema,
  modelName: z.string().describe("Anki note type name"),
  tags: z.array(z.string()),
  fields: z.record(z.string(), noteFieldSchema),
  cardIds: z.array(
    z.number().int().positive().describe("Card generated from the note"),
  ),
  modifiedAt: z
    .string()
    .describe("Note modification time as an ISO 8601 timestamp"),
});

export const noteDraftValidationSchema = z.object({
  index: z.number().int().nonnegative(),
  canCreate: z.boolean(),
  error: z.string().nullable(),
});

export type NoteDraft = z.infer<typeof noteDraftSchema>;
export type NoteSummary = z.infer<typeof noteSummarySchema>;
export type NoteDetails = z.infer<typeof noteDetailsSchema>;
export type NoteDraftValidation = z.infer<
  typeof noteDraftValidationSchema
>;
