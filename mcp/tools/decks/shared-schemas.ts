import { z } from "zod";

export const deckIdSchema = z.number().int().positive();
export const cardIdSchema = z.number().int().positive();
export const deckNameSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Full deck name. Use "::" between parent and child deck names, for example "Languages::German".',
  );

export const deckSummarySchema = z.object({
  id: deckIdSchema.describe("Anki deck ID"),
  name: z.string().describe("Full deck name"),
  parentName: z
    .string()
    .nullable()
    .describe("Full parent deck name, or null for a top-level deck"),
  depth: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based depth in the deck hierarchy"),
});

export const deckStatsSchema = z.object({
  id: deckIdSchema.describe("Anki deck ID"),
  name: z.string().describe("Full deck name"),
  newCount: z.number().int().nonnegative(),
  learningCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
  totalCards: z.number().int().nonnegative().optional(),
});

export type DeckSummary = z.infer<typeof deckSummarySchema>;
export type DeckStats = z.infer<typeof deckStatsSchema>;
