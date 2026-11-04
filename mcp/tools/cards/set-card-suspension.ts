import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setAnkiCardsSuspended } from "../../../anki-api/cards/card-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  applyAndVerifyCardMutation,
  loadCardMutationScope,
} from "./card-mutation-utils.js";
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
    "Suspends or unsuspends existing cards and verifies their saved suspension state. Missing Cards block the whole selection. Suspended cards do not appear during normal reviews.",
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
  const cards = await loadCardMutationScope(cardIds);
  const updatedCardIds = cards
    .filter((card) => (card.queue === -1) !== suspended)
    .map(({ cardId }) => cardId);
  const unchangedCardIds = cards
    .filter((card) => (card.queue === -1) === suspended)
    .map(({ cardId }) => cardId);

  if (updatedCardIds.length > 0) {
    await applyAndVerifyCardMutation(
      suspended ? "suspension" : "unsuspension", cards,
      [{ cardIds: updatedCardIds, apply: () => setAnkiCardsSuspended(updatedCardIds, suspended) }],
      (card) => (card.queue === -1) === suspended,
    );
  }

  return createToolResult(
    `${suspended ? "Suspended" : "Unsuspended"} and verified ${updatedCardIds.length} card${updatedCardIds.length === 1 ? "" : "s"}; ${unchangedCardIds.length} already had the requested state.`,
    {
      suspended,
      updatedCardIds,
      unchangedCardIds,
      missingCardIds: [],
    },
  );
}
