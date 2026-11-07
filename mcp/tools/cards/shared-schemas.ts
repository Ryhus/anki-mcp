import { z } from "zod";

export const CARD_BATCH_LIMIT = 100;
export const CARD_DETAILS_BATCH_LIMIT = 20;
export const CARD_HISTORY_BATCH_LIMIT = 20;

export const cardIdSchema = z
  .number()
  .int()
  .positive()
  .describe("Anki card ID");

export const cardIdListSchema = z
  .array(cardIdSchema)
  .min(1)
  .max(CARD_BATCH_LIMIT)
  .describe(`One to ${CARD_BATCH_LIMIT} Anki card IDs`);

export const cardDetailsIdListSchema = z
  .array(cardIdSchema)
  .min(1)
  .max(CARD_DETAILS_BATCH_LIMIT)
  .describe(
    `One to ${CARD_DETAILS_BATCH_LIMIT} card IDs whose fields and scheduling details should be returned`,
  );

export const cardHistoryIdListSchema = z
  .array(cardIdSchema)
  .min(1)
  .max(CARD_HISTORY_BATCH_LIMIT)
  .describe(
    `One to ${CARD_HISTORY_BATCH_LIMIT} card IDs whose review history should be returned`,
  );

export const cardIntervalSchema = z.object({
  value: z.number().nonnegative(),
  unit: z.enum(["seconds", "days"]),
});

export const cardStateSchema = z.enum([
  "new",
  "learning",
  "review",
  "relearning",
  "suspended",
  "buried",
  "preview",
  "unknown",
]);

export const cardFlagSchema = z.enum([
  "none",
  "red",
  "orange",
  "green",
  "blue",
  "pink",
  "turquoise",
  "purple",
]);

export const cardFlagOutputSchema = z.enum([
  ...cardFlagSchema.options,
  "unknown",
]);

export const cardFieldSchema = z.object({
  value: z.string(),
  order: z.number().int().nonnegative(),
});

export const cardSummarySchema = z.object({
  cardId: cardIdSchema,
  noteId: z.number().int().positive().describe("Parent Anki note ID"),
  deckName: z.string(),
  modelName: z.string().describe("Anki note type name"),
  templateOrdinal: z.number().int().nonnegative(),
  state: cardStateSchema,
  isDue: z.boolean(),
  isSuspended: z.boolean(),
  interval: cardIntervalSchema,
  easePercent: z.number().nonnegative().nullable(),
  repetitions: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  flag: cardFlagOutputSchema,
});

export const cardDetailsSchema = cardSummarySchema.extend({
  fields: z.record(z.string(), cardFieldSchema),
  modifiedAt: z
    .string()
    .describe("Card modification time as an ISO 8601 timestamp"),
  rendered: z
    .object({
      question: z.string(),
      answer: z.string(),
    })
    .optional(),
});

export type CardInterval = z.infer<typeof cardIntervalSchema>;
export type CardState = z.infer<typeof cardStateSchema>;
export type CardFlag = z.infer<typeof cardFlagSchema>;
export type CardFlagOutput = z.infer<typeof cardFlagOutputSchema>;
export type CardSummary = z.infer<typeof cardSummarySchema>;
export type CardDetails = z.infer<typeof cardDetailsSchema>;
