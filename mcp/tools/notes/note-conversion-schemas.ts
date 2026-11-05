import { z } from "zod";
import { conversionMappingSchema } from "../../../anki-api/notes/note-conversion-client.js";
import { NOTE_MUTATION_BATCH_LIMIT, noteIdSchema } from "./shared-schemas.js";

export const CONVERSION_CARD_LIMIT = 500;
export const CONVERSION_SAMPLE_LIMIT = 20;
export const CONVERSION_FIELD_LIMIT = 100;
export const CONVERSION_TEMPLATE_LIMIT = 50;

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const noteType = z.object({ id, name: z.string(), kind: z.enum(["normal", "cloze"]) });

export const noteConversionInputSchema = z.object({
  noteIds: z.array(noteIdSchema).min(1).max(NOTE_MUTATION_BATCH_LIMIT)
    .describe("Explicit Note IDs belonging to the same source Note Type"),
  targetNoteTypeId: id.describe("Existing destination Note Type ID from list-note-types"),
  fields: z.array(conversionMappingSchema).min(1).max(CONVERSION_FIELD_LIMIT).optional()
    .describe("One mapping per target field; null source leaves it empty. Omit to use Anki's suggested mapping."),
  templates: z.array(conversionMappingSchema).min(1).max(CONVERSION_TEMPLATE_LIMIT).optional()
    .describe("One mapping per target template; null source does not preserve an old Card in that slot. Omit to use Anki's suggestion."),
  dryRun: z.boolean().default(true),
  expectedImpactHash: hash.optional().describe("Hash from a reviewed preview of this exact selection and mapping"),
  confirmConversion: z.boolean().default(false),
  confirmDataLoss: z.boolean().default(false).describe("Required when nonempty fields or existing Cards would be discarded"),
  confirmCardCreation: z.boolean().default(false).describe("Required when native generation could create new Cards"),
}).superRefine(({ dryRun, expectedImpactHash, confirmConversion }, context) => {
  if (dryRun) return;
  if (expectedImpactHash === undefined) context.addIssue({ code: "custom", path: ["expectedImpactHash"], message: "Applying requires a reviewed impact hash" });
  if (!confirmConversion) context.addIssue({ code: "custom", path: ["confirmConversion"], message: "Confirm the reviewed conversion before applying" });
});

const impactSchema = z.object({
  noteCount: count,
  preservedCardCount: count,
  removedCardCount: count,
  possibleNewCardCount: count.describe("Upper bound; Anki decides which target templates generate Cards"),
  droppedNonEmptyFieldValueCount: count,
  droppedFields: z.array(z.object({
    fieldName: z.string(), nonEmptyNoteCount: count, sampleNoteIds: z.array(id).max(CONVERSION_SAMPLE_LIMIT),
  })).max(CONVERSION_FIELD_LIMIT),
  samplePreservedCardIds: z.array(id).max(CONVERSION_SAMPLE_LIMIT),
  sampleRemovedCardIds: z.array(id).max(CONVERSION_SAMPLE_LIMIT),
});

export const noteConversionOutputSchema = z.object({
  dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(),
  sourceNoteType: noteType.nullable(), targetNoteType: noteType.nullable(),
  fields: z.array(conversionMappingSchema).max(CONVERSION_FIELD_LIMIT),
  templates: z.array(conversionMappingSchema).max(CONVERSION_TEMPLATE_LIMIT),
  impactHash: hash.nullable(), impact: impactSchema.nullable(),
  missingNoteIds: z.array(id), blockers: z.array(z.string()), warnings: z.array(z.string()),
  convertedNotes: z.array(z.object({
    noteId: id,
    preservedCardIds: z.array(id),
    removedCardIds: z.array(id),
    newCardIds: z.array(id),
  })),
});

export type NoteConversionInput = z.infer<typeof noteConversionInputSchema>;
export type NoteConversionImpact = z.infer<typeof impactSchema>;
export type NoteConversionOutput = z.infer<typeof noteConversionOutputSchema>;
