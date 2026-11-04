import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { setAnkiCardFlag } from "../../../anki-api/cards/card-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  toCardFlag,
  toCardFlagValue,
} from "./card-normalizers.js";
import { loadCardInfo } from "./card-loader.js";
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
    "Applies one of Anki's supported flag colors to existing cards without exposing arbitrary internal card fields.",
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
  const { cards, missingCardIds } = await loadCardInfo(cardIds);
  const unchangedCardIds = cards
    .filter((info) => toCardFlag(info.flags) === flag)
    .map((info) => info.cardId);
  const cardsToUpdate = cards.filter(
    (info) => toCardFlag(info.flags) !== flag,
  );
  const updatedCardIds: number[] = [];
  const failedCardIds: number[] = [];
  const flagValue = toCardFlagValue(flag);

  for (const info of cardsToUpdate) {
    try {
      await setAnkiCardFlag(info.cardId, flagValue);
      updatedCardIds.push(info.cardId);
    } catch {
      failedCardIds.push(info.cardId);
    }
  }

  return createToolResult(
    `Set the ${flag} flag on ${updatedCardIds.length} card${updatedCardIds.length === 1 ? "" : "s"}; ${unchangedCardIds.length} were unchanged, ${missingCardIds.length} were not found, and ${failedCardIds.length} failed.`,
    {
      flag,
      updatedCardIds,
      unchangedCardIds,
      missingCardIds,
      failedCardIds,
    },
  );
}
