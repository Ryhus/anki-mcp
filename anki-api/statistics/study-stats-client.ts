import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { createAnkiAction, invokeAnkiMulti } from "../anki-request.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter } from "../v1/anki-v1-adapter-utils.js";

const count = z.number().int().nonnegative();
const day = z.iso.date();
const todaySchema = z.object({ count, day, nextDayAt: z.iso.datetime() });
const daySchema = z.object({ day, count });
const legacyDaysSchema = z.array(z.tuple([day, count]));

export const studySummarySchema = z.object({
  cardCount: count.describe("All existing cards in the selected scope."),
  noteCount: count.describe("Distinct notes linked to those cards. Notes without a matching card are not counted."),
  reviewCount: count.describe("Recorded card answers across available history, not the number of cards due today."),
  reviewTimeMs: count.describe("Total time attributed to those answers, in milliseconds as reported by Anki."),
  newCount: count.describe("Active new cards, not the daily new-card allowance."),
  learningCount: count.describe("Active learning and relearning cards."),
  reviewCardCount: count.describe("Active review cards, whether due now or not."),
  suspendedCount: count.describe("Suspended cards. Buried cards are not reported as a separate category."),
});

/** Reads Anki's structured aggregate, optionally scoped to one deck and its children. */
export async function readStudySummary(deckId?: number) {
  const method = "statistics.getSummary";
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "The study summary tool requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  return ctx.request(method, deckId === undefined ? {} : { deck: { id: String(deckId) } }, studySummarySchema);
}

/** Reads collection-wide statistics using Anki's own scheduler day. */
export async function readStudyStats() {
  if (useAnkiV1("statistics.getToday")) {
    const ctx = await openV1Adapter({});
    const [today, days] = await Promise.all([
      ctx.request("statistics.getToday", {}, todaySchema),
      ctx.request("statistics.getReviewDays", {}, z.array(daySchema)),
    ]);
    return { reviewedToday: today.count, todayDate: today.day, nextDayAt: today.nextDayAt, days };
  }
  const [today, days] = await invokeAnkiMulti([
    createAnkiAction<unknown>("getNumCardsReviewedToday"),
    createAnkiAction<unknown>("getNumCardsReviewedByDay"),
  ] as const);
  const parsedCount = count.safeParse(today);
  const parsedDays = legacyDaysSchema.safeParse(days);
  if (!parsedCount.success || !parsedDays.success) {
    throw new Error("AnkiConnect returned malformed study statistics.");
  }
  return {
    reviewedToday: parsedCount.data, todayDate: null, nextDayAt: null,
    days: parsedDays.data.map(([day, count]) => ({ day, count })),
  };
}
