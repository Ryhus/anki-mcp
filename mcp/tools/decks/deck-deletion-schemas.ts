import { z } from "zod";
import { deckIdSchema, deckNameSchema, cardIdSchema } from "./shared-schemas.js";

export const DECK_DELETION_LIMITS = { decks: 100, cards: 5_000, notes: 1_000, referencedCards: 10_000, sample: 20, batch: 250 } as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const deletionDeckSchema = z.object({ id: deckIdSchema, name: z.string() });

export const deckDeletionInputSchema = z.object({
  name: deckNameSchema.describe("Exact root deck name; its descendants are included in deletion"),
  dryRun: z.boolean().default(true),
  expectedImpactHash: hashSchema.optional().describe("impactHash from a complete reviewed preview; required when applying"),
  confirmDeletion: z.boolean().default(false).describe("Must be true after user approval when applying destructive deck/Card loss"),
}).superRefine(({ dryRun, expectedImpactHash, confirmDeletion }, context) => {
  if (dryRun) return;
  if (expectedImpactHash === undefined) context.addIssue({ code: "custom", path: ["expectedImpactHash"], message: "expectedImpactHash is required when dryRun is false" });
  if (!confirmDeletion) context.addIssue({ code: "custom", path: ["confirmDeletion"], message: "confirmDeletion must be true when dryRun is false" });
});

export const deckDeletionImpactSchema = z.object({
  deckCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative().nullable(),
  affectedNoteCount: z.number().int().nonnegative().nullable(),
  deletedNoteCount: z.number().int().nonnegative().nullable(),
  survivingNoteCount: z.number().int().nonnegative().nullable(),
  preservedCardCount: z.number().int().nonnegative().nullable(),
  sampleDecks: z.array(deletionDeckSchema).max(DECK_DELETION_LIMITS.sample),
  decksTruncated: z.boolean(),
  sampleCardIds: z.array(cardIdSchema).max(DECK_DELETION_LIMITS.sample),
  cardsTruncated: z.boolean(),
  sampleNotes: z.array(z.object({
    noteId: z.number().int().positive(), modelName: z.string(),
    willBeDeleted: z.boolean(), deletedCardCount: z.number().int().nonnegative(),
    preservedCardCount: z.number().int().nonnegative(),
  })).max(DECK_DELETION_LIMITS.sample),
  notesTruncated: z.boolean(),
});

export const deckDeletionOutputSchema = z.object({
  dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(), exists: z.boolean(),
  profileName: z.string(), deck: deletionDeckSchema.nullable(),
  impactComplete: z.boolean(), impactHash: hashSchema.nullable(),
  impact: deckDeletionImpactSchema,
  deletedDeck: deletionDeckSchema.nullable(),
  deletedDecks: z.array(deletionDeckSchema),
  deletedCards: z.boolean(),
  blockers: z.array(z.string()), warnings: z.array(z.string()),
});

export type DeckDeletionInput = z.infer<typeof deckDeletionInputSchema>;
export type DeletionDeck = z.infer<typeof deletionDeckSchema>;
