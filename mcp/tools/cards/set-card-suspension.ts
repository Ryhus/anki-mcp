import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setAnkiCardsSuspended } from "../../../anki-api/cards/card-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCards } from "./card-loader.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const setCardSuspensionInputSchema = z.object({
  cardIds: cardIdListSchema,
  suspended: z
    .boolean()
    .describe("True to suspend the cards, false to unsuspend them"),
});

type SetCardSuspensionInput = z.infer<typeof setCardSuspensionInputSchema>;

export const setCardSuspensionConfig = {
  title: "Set card suspension",
  description:
    "Suspends or unsuspends existing cards. Suspended cards do not appear during normal reviews.",
  inputSchema: setCardSuspensionInputSchema,
  outputSchema: z.object({
    suspended: z.boolean(),
    updatedCardIds: z.array(cardIdSchema),
    unchangedCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Changes only cards whose suspension state differs from the requested state. */
export async function setCardSuspension({
  cardIds,
  suspended,
}: SetCardSuspensionInput): Promise<CallToolResult> {
  const { cards, missingCardIds } = await loadCards(cardIds);
  const updatedCardIds = cards
    .filter((card) => card.isSuspended !== suspended)
    .map(({ info }) => info.cardId);
  const unchangedCardIds = cards
    .filter((card) => card.isSuspended === suspended)
    .map(({ info }) => info.cardId);

  if (updatedCardIds.length > 0) {
    await setAnkiCardsSuspended(updatedCardIds, suspended);
  }

  return createToolResult(
    `${suspended ? "Suspended" : "Unsuspended"} ${updatedCardIds.length} card${updatedCardIds.length === 1 ? "" : "s"}; ${unchangedCardIds.length} already had the requested state and ${missingCardIds.length} were not found.`,
    {
      suspended,
      updatedCardIds,
      unchangedCardIds,
      missingCardIds,
    },
  );
}
