import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { rescheduleAnkiCards } from "../../../anki-api/cards/card-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  applyAndVerifyCardMutation,
  loadCardMutationScope,
} from "./card-mutation-utils.js";
import { cardDueSchema, verifyCardDueDates } from "./card-due-date-utils.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const rescheduleCardsInputSchema = z.object({
  cardIds: cardIdListSchema,
  due: cardDueSchema.describe(
    'Anki Set Due Date value: "0" means today, "1!" requests tomorrow with an interval reset under the current scheduler, and "3-7" chooses a random day in that range',
  ),
});

type RescheduleCardsInput = z.infer<typeof rescheduleCardsInputSchema>;

export const rescheduleCardsConfig = {
  title: "Reschedule cards",
  description:
    "Changes due dates and verifies the saved review state and requested date range using Anki's native search. Missing Cards block the whole selection. New cards become review cards, and ranges choose a random due date; never blindly retry after an error.",
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
  const cards = await loadCardMutationScope(cardIds);
  const rescheduledCardIds = cards.map(({ cardId }) => cardId);

  if (rescheduledCardIds.length > 0) {
    await applyAndVerifyCardMutation(
      "rescheduling", cards,
      [{ cardIds: rescheduledCardIds, apply: () => rescheduleAnkiCards(rescheduledCardIds, due) }],
      (card) => card.type === 2 && card.queue === 2,
      () => verifyCardDueDates(rescheduledCardIds, due),
    );
  }

  return createToolResult(
    `Rescheduled and verified ${rescheduledCardIds.length} card${rescheduledCardIds.length === 1 ? "" : "s"} with due value "${due}".`,
    { due, rescheduledCardIds, missingCardIds: [] },
  );
}
