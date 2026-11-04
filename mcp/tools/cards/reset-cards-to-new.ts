import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resetAnkiCardsToNew } from "../../../anki-api/cards/card-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCardInfo } from "./card-loader.js";
import { cardIdListSchema, cardIdSchema } from "./shared-schemas.js";

const resetCardsToNewInputSchema = z.object({
  cardIds: cardIdListSchema,
});

type ResetCardsToNewInput = z.infer<typeof resetCardsToNewInputSchema>;

export const resetCardsToNewConfig = {
  title: "Reset cards to new",
  description:
    "Resets the scheduling progress of existing cards and returns them to Anki's new-card state.",
  inputSchema: resetCardsToNewInputSchema,
  outputSchema: z.object({
    resetCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Resets only validated existing cards to the new state. */
export async function resetCardsToNew({
  cardIds,
}: ResetCardsToNewInput): Promise<CallToolResult> {
  const { cards, missingCardIds } = await loadCardInfo(cardIds);
  const resetCardIds = cards.map(({ cardId }) => cardId);

  if (resetCardIds.length > 0) {
    await resetAnkiCardsToNew(resetCardIds);
  }

  return createToolResult(
    `Reset ${resetCardIds.length} card${resetCardIds.length === 1 ? "" : "s"} to new; ${missingCardIds.length} were not found.`,
    { resetCardIds, missingCardIds },
  );
}
