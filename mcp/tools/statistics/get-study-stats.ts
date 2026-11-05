import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readStudyStats } from "../../../anki-api/statistics/study-stats-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";

const inputSchema = z.object({
  limitDays: z.number().int().min(1).max(366).default(30)
    .describe("Maximum number of recent days with reviews. Days without reviews are omitted."),
});

export const getStudyStatsConfig = {
  title: "Get study statistics",
  description: "Reads collection-wide review counts for Anki's current study day and recent days with reviews. Does not change data or include per-deck counts.",
  inputSchema,
  outputSchema: z.object({
    reviewedToday: z.number().int().nonnegative(),
    todayDate: z.iso.date().nullable().describe("Anki's scheduler date; unavailable in legacy mode"),
    nextDayAt: z.iso.datetime().nullable().describe("Next Anki day boundary; unavailable in legacy mode"),
    reviewDays: z.array(z.object({ date: z.iso.date(), reviewCount: z.number().int().positive() })).max(366),
    hasMore: z.boolean(),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getStudyStats({ limitDays }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const { reviewedToday, todayDate, nextDayAt, days } = await readStudyStats();
  if (new Set(days.map(({ day }) => day)).size !== days.length) {
    throw new Error("AnkiConnect returned duplicate study dates.");
  }
  const activeDays = days.filter(({ count }) => count > 0);
  const reviewDays = activeDays.sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, limitDays).map(({ day, count }) => ({ date: day, reviewCount: count }));
  return createToolResult(
    `Anki recorded ${reviewedToday} review${reviewedToday === 1 ? "" : "s"} today. Returned ${reviewDays.length} recent study day${reviewDays.length === 1 ? "" : "s"}.`,
    { reviewedToday, todayDate, nextDayAt, reviewDays, hasMore: activeDays.length > reviewDays.length },
  );
}
