import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { createAnkiAction, invokeAnkiMulti } from "../anki-request.js";
import { openV1Adapter } from "../v1/anki-v1-adapter-utils.js";

const count = z.number().int().nonnegative();
const day = z.iso.date();
const todaySchema = z.object({ count, day, nextDayAt: z.iso.datetime() });
const daySchema = z.object({ day, count });
const legacyDaysSchema = z.array(z.tuple([day, count]));

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
