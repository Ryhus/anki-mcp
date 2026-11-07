import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resetAnkiCardsToNew } from "../../../anki-api/cards/card-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  applyAndVerifyCardMutation,
  loadCardMutationScope,
} from "./card-mutation-utils.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const resetCardsToNewInputSchema = z.object({
  cardIds: cardIdListSchema,
});

type ResetCardsToNewInput = z.infer<typeof resetCardsToNewInputSchema>;

export const resetCardsToNewConfig = {
  title: "Reset cards to new",
  description:
    "Resets scheduling and verifies the saved New state. Missing Cards block the whole selection. Anki may log the reset; review history and repetition counts are not promised to be erased. Never blindly retry after an error.",
  inputSchema: resetCardsToNewInputSchema,
  outputSchema: z.object({
    resetCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Resets only validated existing cards to the new state. */
export async function resetCardsToNew({
  cardIds,
}: ResetCardsToNewInput): Promise<CallToolResult> {
  const cards = await loadCardMutationScope(cardIds);
  const resetCardIds = cards.map(({ cardId }) => cardId);

  if (resetCardIds.length > 0) {
    await applyAndVerifyCardMutation(
      "reset to New", cards,
      [{ cardIds: resetCardIds, apply: () => resetAnkiCardsToNew(resetCardIds) }],
      (card) => card.type === 0 && card.queue === 0 && card.interval === 0 && card.factor === 0,
    );
  }

  return createToolResult(
    `Reset and verified ${resetCardIds.length} card${resetCardIds.length === 1 ? "" : "s"} to New. Existing review history may remain.`,
    { resetCardIds, missingCardIds: [] },
  );
}
