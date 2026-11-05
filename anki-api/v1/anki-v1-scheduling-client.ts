import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, type V1AdapterContext } from "./anki-v1-adapter-utils.js";
import { v1EntityIdSchema } from "./anki-v1-collection-client.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";

const predictMethod = "scheduling.predict";
export const v1CardRatings = ["again", "hard", "good", "easy"] as const;
export const cardPredictionAnswerSchema = z.object({
  rating: z.enum(v1CardRatings),
  label: z.string().describe("Anki's display label, in Anki's configured language."),
  interval: z.object({
    value: z.number().int().nonnegative(),
    unit: z.enum(["seconds", "days"]),
  }).nullable().describe("Native interval, or null when Anki does not report a numeric interval."),
});

const predictionSchema = z.object({
  cardId: v1EntityIdSchema,
  source: z.literal("scheduler"),
  stateToken: z.string().min(1),
  answers: z.array(cardPredictionAnswerSchema).min(1).max(v1CardRatings.length),
});

export const cardDueFlagsSchema = z.object({
  dueNow: z.boolean().describe("The scheduled time or study day has arrived. Excludes new cards and learn-ahead."),
  available: z.boolean().describe("Eligible by the card's queue and timing, including new cards. Ignores daily deck limits and review order."),
  learnAhead: z.boolean().describe("The card is not due yet but is within Anki's learn-ahead window, regardless of includeLearnAhead."),
});

const cardDueReplySchema = cardDueFlagsSchema.extend({ cardId: v1EntityIdSchema });

/** Reads Anki's queue-aware eligibility without using local time or review history. */
export async function readCardDueStatus(cardId: number, includeLearnAhead: boolean) {
  const method = "scheduling.getDue";
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "Card due status requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  const status = await ctx.request(method, { cardId: String(cardId), includeLearnAhead }, cardDueReplySchema);
  if (status.cardId !== cardId) throw invalidAnkiV1Response(method);
  return { ...status, includeLearnAhead };
}

/** Internal prediction, including the token needed by guarded relearning. */
export async function predictV1Card(ctx: V1AdapterContext, cardId: number) {
  const result = await ctx.request(predictMethod, { cardId: String(cardId) }, predictionSchema);
  if (result.cardId !== cardId || new Set(result.answers.map(({ rating }) => rating)).size !== result.answers.length) {
    throw invalidAnkiV1Response(predictMethod);
  }
  return result;
}

/** Returns only the public, read-only projection, never the answer token. */
export async function readCardIntervalPrediction(cardId: number) {
  if (!useAnkiV1(predictMethod)) {
    throw new AnkiRequestError("configuration", predictMethod, "Card interval prediction requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  const { source, answers } = await predictV1Card(ctx, cardId);
  if (answers.length !== v1CardRatings.length) throw invalidAnkiV1Response(predictMethod);
  return {
    cardId, source,
    answers: answers.sort((a, b) => v1CardRatings.indexOf(a.rating) - v1CardRatings.indexOf(b.rating)),
  };
}
