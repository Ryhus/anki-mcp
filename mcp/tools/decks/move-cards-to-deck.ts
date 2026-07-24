import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getCardsByDeck,
  moveAnkiCards,
} from "../../../anki-api/decks/deck-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { unique } from "./deck-utils.js";
import { cardIdSchema, deckNameSchema } from "./shared-schemas.js";

const moveCardsInputSchema = z.object({
  cardIds: z.array(cardIdSchema).min(1).describe("IDs of cards to move"),
  targetDeck: deckNameSchema.describe(
    "Destination deck. It will be created if it does not exist.",
  ),
});

type MoveCardsInput = z.infer<typeof moveCardsInputSchema>;

export const moveCardsToDeckConfig = {
  title: "Move cards to deck",
  description:
    "Moves cards to another deck. Creates the target deck if it does not exist and removes the cards from filtered decks before moving them.",
  inputSchema: moveCardsInputSchema,
  outputSchema: z.object({
    movedCardCount: z.number().int().nonnegative(),
    cardIds: z.array(cardIdSchema),
    targetDeck: z.string(),
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/**
 * Validates card IDs before moving them to a deck. AnkiConnect creates the
 * target deck when it does not already exist.
 */
export async function moveCardsToDeck({
  cardIds,
  targetDeck,
}: MoveCardsInput): Promise<CallToolResult> {
  const uniqueCardIds = unique(cardIds);

  await getCardsByDeck(uniqueCardIds);
  await moveAnkiCards(uniqueCardIds, targetDeck);

  return createToolResult(
    `Moved ${uniqueCardIds.length} card${uniqueCardIds.length === 1 ? "" : "s"} to "${targetDeck}".`,
    {
      movedCardCount: uniqueCardIds.length,
      cardIds: uniqueCardIds,
      targetDeck,
    },
  );
}
