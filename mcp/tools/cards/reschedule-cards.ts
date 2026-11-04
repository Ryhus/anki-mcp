import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { rescheduleAnkiCards } from "../../../anki-api/cards/card-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCardInfo } from "./card-loader.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const dueSchema = z
  .string()
  .trim()
  .regex(
    /^\d+(?:-\d+)?!?$/,
    'Use Anki Set Due Date syntax such as "0", "1!", or "3-7"',
  )
  .refine(isAscendingRange, {
    message: "The start of a due-date range must not exceed its end",
  });

const rescheduleCardsInputSchema = z.object({
  cardIds: cardIdListSchema,
  due: dueSchema.describe(
    'Anki Set Due Date value: "0" means today, "1!" means tomorrow and interval 1, and "3-7" chooses a random day in that range',
  ),
});

type RescheduleCardsInput = z.infer<typeof rescheduleCardsInputSchema>;

export const rescheduleCardsConfig = {
  title: "Reschedule cards",
  description:
    "Changes the due date of existing cards. New cards become review cards, and ranges choose a random due date.",
  inputSchema: rescheduleCardsInputSchema,
  outputSchema: z.object({
    due: z.string(),
    rescheduledCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Validates card IDs before applying Anki's Set Due Date operation. */
export async function rescheduleCards({
  cardIds,
  due,
}: RescheduleCardsInput): Promise<CallToolResult> {
  const { cards, missingCardIds } = await loadCardInfo(cardIds);
  const rescheduledCardIds = cards.map(({ cardId }) => cardId);

  if (rescheduledCardIds.length > 0) {
    await rescheduleAnkiCards(rescheduledCardIds, due);
  }

  return createToolResult(
    `Rescheduled ${rescheduledCardIds.length} card${rescheduledCardIds.length === 1 ? "" : "s"} with due value "${due}"; ${missingCardIds.length} were not found.`,
    { due, rescheduledCardIds, missingCardIds },
  );
}

function isAscendingRange(value: string): boolean {
  const withoutIntervalOverride = value.endsWith("!")
    ? value.slice(0, -1)
    : value;
  const [start, end] = withoutIntervalOverride.split("-").map(Number);

  return start !== undefined && (end === undefined || start <= end);
}
