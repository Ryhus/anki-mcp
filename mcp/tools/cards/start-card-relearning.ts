import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { startAnkiCardsRelearning } from "../../../anki-api/cards/card-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  applyAndVerifyCardMutation,
  loadCardMutationScope,
} from "./card-mutation-utils.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const startCardRelearningInputSchema = z.object({
  cardIds: cardIdListSchema,
});

type StartCardRelearningInput = z.infer<
  typeof startCardRelearningInputSchema
>;

export const startCardRelearningConfig = {
  title: "Start card relearning",
  description:
    "Starts relearning for active Review cards and verifies the result. Current AnkiConnect may implement this as an Again answer, adding review history and changing repetitions/lapses. Cards may return directly to Review or be suspended by leech settings. Missing/non-Review Cards block the whole selection. Not idempotent; never blindly retry.",
  inputSchema: startCardRelearningInputSchema,
  outputSchema: z.object({
    relearningCardIds: z.array(cardIdSchema),
    reviewCardIds: z.array(cardIdSchema),
    suspendedCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Verifies the actual result instead of promising every card enters a queue. */
export async function startCardRelearning({
  cardIds,
}: StartCardRelearningInput): Promise<CallToolResult> {
  const cards = await loadCardMutationScope(cardIds);
  const invalid = cards.filter((card) => card.type !== 2 || card.queue !== 2);
  if (invalid.length > 0) {
    throw new Error(`No Cards were changed. Relearning requires active Review Cards; invalid IDs: ${invalid.map(({ cardId }) => cardId).join(", ")}.`);
  }
  const selectedCardIds = cards.map(({ cardId }) => cardId);
  let after = cards;

  if (selectedCardIds.length > 0) {
    after = await applyAndVerifyCardMutation(
      "relearning", cards,
      [{ cardIds: selectedCardIds, apply: () => startAnkiCardsRelearning(selectedCardIds) }],
      (card, before) => {
        if (card.type === 3 && [1, 3].includes(card.queue)) return true;
        // Native Again can skip the relearning queue or suspend a leech.
        // In these cases a review-state noop is not evidence of execution.
        const reviewed = card.reps === before.reps + 1 && card.lapses === before.lapses + 1;
        return reviewed && (
          (card.type === 2 && card.queue === 2) ||
          ([2, 3].includes(card.type) && card.queue === -1)
        );
      },
    );
  }
  const relearningCardIds = after.filter((card) => card.type === 3 && card.queue !== -1).map(({ cardId }) => cardId);
  const reviewCardIds = after.filter((card) => card.type === 2 && card.queue === 2).map(({ cardId }) => cardId);
  const suspendedCardIds = after.filter((card) => card.queue === -1).map(({ cardId }) => cardId);

  return createToolResult(
    `Verified relearning results: ${relearningCardIds.length} in relearning, ${reviewCardIds.length} returned directly to Review, ${suspendedCardIds.length} suspended. Anki may have recorded Again answers; do not repeat as a harmless retry.`,
    { relearningCardIds, reviewCardIds, suspendedCardIds, missingCardIds: [] },
  );
}
