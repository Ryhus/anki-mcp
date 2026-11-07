import { z } from "zod";
import { noteIdSchema, noteMutationIdListSchema } from "./shared-schemas.js";

export const NOTE_DELETION_FIELD_SAMPLE_LIMIT = 3;
export const NOTE_DELETION_FIELD_PREVIEW_LIMIT = 200;
export const NOTE_DELETION_CARD_SAMPLE_LIMIT = 20;

const impactHashSchema = z.string().regex(/^[a-f0-9]{64}$/u).describe(
  "SHA-256 of the complete reviewed Note deletion impact, not just displayed samples",
);
const cardIdSchema = z.number().int().positive();

export const noteDeletionInputSchema = z.object({
  noteIds: noteMutationIdListSchema.describe(
    "Explicit Note IDs; duplicates are ignored. Search queries are not accepted.",
  ),
  dryRun: z.boolean().default(true).describe(
    "Preview Notes and generated Cards without deleting anything",
  ),
  expectedImpactHash: impactHashSchema.optional().describe(
    "impactHash returned by a complete preview; required when dryRun is false",
  ),
  confirmDeletion: z.boolean().default(false).describe(
    "Must be true when applying, after the user approves permanent Note/Card data loss",
  ),
}).superRefine(({ dryRun, expectedImpactHash, confirmDeletion }, context) => {
  if (dryRun) return;
  if (expectedImpactHash === undefined) {
    context.addIssue({ code: "custom", path: ["expectedImpactHash"], message: "expectedImpactHash is required when dryRun is false" });
  }
  if (!confirmDeletion) {
    context.addIssue({ code: "custom", path: ["confirmDeletion"], message: "confirmDeletion must be true when dryRun is false" });
  }
});

export const noteDeletionImpactSchema = z.object({
  requestedNoteCount: z.number().int().nonnegative(),
  noteCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  notes: z.array(z.object({
    noteId: noteIdSchema,
    modelName: z.string(),
    fieldPreviews: z.record(z.string(), z.string().max(NOTE_DELETION_FIELD_PREVIEW_LIMIT)),
    fieldPreviewsTruncated: z.boolean(),
    cardCount: z.number().int().nonnegative(),
    sampleCardIds: z.array(cardIdSchema).max(NOTE_DELETION_CARD_SAMPLE_LIMIT),
    cardIdsTruncated: z.boolean(),
  })),
});

export const noteDeletionOutputSchema = z.object({
  dryRun: z.boolean(),
  applied: z.boolean(),
  verified: z.boolean(),
  profileName: z.string(),
  impactHash: impactHashSchema.nullable().describe(
    "Null if any requested Note is missing or could not be loaded; no partial batch is deleted",
  ),
  impact: noteDeletionImpactSchema,
  deletedNotes: z.array(z.object({
    noteId: noteIdSchema,
    deletedCardIds: z.array(cardIdSchema),
  })),
  missingNoteIds: z.array(noteIdSchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type NoteDeletionInput = z.infer<typeof noteDeletionInputSchema>;
export type NoteDeletionImpact = z.infer<typeof noteDeletionImpactSchema>;
