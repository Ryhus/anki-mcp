import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setAnkiCardFlag } from "../../../anki-api/cards/card-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  toCardFlag,
  toCardFlagValue,
} from "./card-normalizers.js";
import {
  applyAndVerifyCardMutation,
  loadCardMutationScope,
} from "./card-mutation-utils.js";
import {
  cardFlagSchema,
  cardIdListSchema,
  cardIdSchema,
} from "./shared-schemas.js";

const setCardFlagInputSchema = z.object({
  cardIds: cardIdListSchema,
  flag: cardFlagSchema.describe(
    "Anki flag color to apply, or none to remove the current flag",
  ),
});

type SetCardFlagInput = z.infer<typeof setCardFlagInputSchema>;

export const setCardFlagConfig = {
  title: "Set card flag",
  description:
    "Applies one of Anki's supported flag colors and verifies saved flags without exposing arbitrary internal card fields. Missing Cards block the whole selection; a write error stops later writes and may leave partial progress.",
  inputSchema: setCardFlagInputSchema,
  outputSchema: z.object({
    flag: cardFlagSchema,
    updatedCardIds: z.array(cardIdSchema),
    unchangedCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
    failedCardIds: z.array(cardIdSchema),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Safely wraps AnkiConnect's generic internal-value setter for flags only. */
export async function setCardFlag({
  cardIds,
  flag,
}: SetCardFlagInput): Promise<CallToolResult> {
  const cards = await loadCardMutationScope(cardIds);
  const unknownFlags = cards.filter((card) => toCardFlag(card.flags) === "unknown");
  if (unknownFlags.length > 0) {
    throw new Error(`No Cards were changed. Current flags are missing or invalid for Card IDs: ${unknownFlags.map(({ cardId }) => cardId).join(", ")}.`);
  }
  const unchangedCardIds = cards
    .filter((info) => toCardFlag(info.flags) === flag)
    .map((info) => info.cardId);
  const cardsToUpdate = cards.filter(
    (info) => toCardFlag(info.flags) !== flag,
  );
  const updatedCardIds = cardsToUpdate.map(({ cardId }) => cardId);
  const flagValue = toCardFlagValue(flag);

  if (cardsToUpdate.length > 0) {
    await applyAndVerifyCardMutation(
      "flag update", cards,
      cardsToUpdate.map(({ cardId }) => ({
        cardIds: [cardId],
        apply: () => setAnkiCardFlag(cardId, flagValue),
      })),
      (card) => toCardFlag(card.flags) === flag,
    );
  }

  return createToolResult(
    `Set and verified the ${flag} flag on ${updatedCardIds.length} card${updatedCardIds.length === 1 ? "" : "s"}; ${unchangedCardIds.length} were unchanged.`,
    {
      flag,
      updatedCardIds,
      unchangedCardIds,
      missingCardIds: [],
      failedCardIds: [],
    },
  );
}
