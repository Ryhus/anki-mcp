import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { startAnkiCardsRelearning } from "../../../anki-api/cards/card-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCardInfo } from "./card-loader.js";
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
    "Forces existing cards into Anki's relearning state and changes their scheduling state.",
  inputSchema: startCardRelearningInputSchema,
  outputSchema: z.object({
    relearningCardIds: z.array(cardIdSchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Moves only validated existing cards into the relearning state. */
export async function startCardRelearning({
  cardIds,
}: StartCardRelearningInput): Promise<CallToolResult> {
  const { cards, missingCardIds } = await loadCardInfo(cardIds);
  const relearningCardIds = cards.map(({ cardId }) => cardId);

  if (relearningCardIds.length > 0) {
    await startAnkiCardsRelearning(relearningCardIds);
  }

  return createToolResult(
    `Started relearning for ${relearningCardIds.length} card${relearningCardIds.length === 1 ? "" : "s"}; ${missingCardIds.length} were not found.`,
    { relearningCardIds, missingCardIds },
  );
}
