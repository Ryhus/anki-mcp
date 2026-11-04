import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCards } from "./card-loader.js";
import { toCardDetails } from "./card-normalizers.js";
import {
  cardDetailsIdListSchema,
  cardDetailsSchema,
  cardIdSchema,
} from "./shared-schemas.js";

const getCardDetailsInputSchema = z.object({
  cardIds: cardDetailsIdListSchema,
  includeRenderedContent: z
    .boolean()
    .default(false)
    .describe(
      "Include rendered question and answer HTML. CSS is never returned.",
    ),
});

type GetCardDetailsInput = z.infer<typeof getCardDetailsInputSchema>;

export const getCardDetailsConfig = {
  title: "Get card details",
  description:
    "Returns note fields and normalized scheduling information for specific cards. Reports missing IDs separately.",
  inputSchema: getCardDetailsInputSchema,
  outputSchema: z.object({
    cards: z.array(cardDetailsSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Returns normalized details without exposing Anki's CSS-heavy raw payload. */
export async function getCardDetails({
  cardIds,
  includeRenderedContent,
}: GetCardDetailsInput): Promise<CallToolResult> {
  const { cards: loadedCards, missingCardIds } = await loadCards(cardIds);
  const cards = loadedCards.map((card) =>
    toCardDetails(card, includeRenderedContent),
  );

  return createToolResult(
    `Returned details for ${cards.length} card${cards.length === 1 ? "" : "s"}${missingCardIds.length === 0 ? "." : `; ${missingCardIds.length} card ID${missingCardIds.length === 1 ? " was" : "s were"} not found.`}`,
    { cards, missingCardIds },
  );
}
