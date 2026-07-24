import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCardsByDeck } from "../../../anki-api/decks/deck-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { compareByName, unique } from "./deck-utils.js";
import { cardIdSchema } from "./shared-schemas.js";

const getCardDecksInputSchema = z.object({
  cardIds: z
    .array(cardIdSchema)
    .min(1)
    .describe("IDs of cards whose deck assignments should be returned"),
});

type GetCardDecksInput = z.infer<typeof getCardDecksInputSchema>;

export const getCardDecksConfig = {
  title: "Get card decks",
  description: "Groups the specified card IDs by their current deck.",
  inputSchema: getCardDecksInputSchema,
  outputSchema: z.object({
    decks: z.array(
      z.object({
        name: z.string().describe("Full deck name"),
        cardIds: z.array(cardIdSchema),
      }),
    ),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/**
 * Groups card IDs by their current deck.
 */
export async function getCardDecks({
  cardIds,
}: GetCardDecksInput): Promise<CallToolResult> {
  const uniqueCardIds = unique(cardIds);
  const cardsByDeck = await getCardsByDeck(uniqueCardIds);
  const decks = Object.entries(cardsByDeck)
    .map(([name, ids]) => ({ name, cardIds: ids }))
    .sort(compareByName);
  const lines = decks.map(
    (deck) => `- ${deck.name}: ${deck.cardIds.join(", ")}`,
  );

  return createToolResult(
    `Found ${uniqueCardIds.length} card${uniqueCardIds.length === 1 ? "" : "s"} in ${decks.length} deck${decks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    { decks },
  );
}
