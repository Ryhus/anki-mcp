import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  cardPredictionAnswerSchema, readCardIntervalPrediction, v1CardRatings,
} from "../../../anki-api/v1/anki-v1-scheduling-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { cardIdSchema } from "./shared-schemas.js";

const inputSchema = z.strictObject({
  cardId: cardIdSchema.describe("One existing card ID, for example from search-cards."),
});

export const predictCardIntervalsConfig = {
  title: "Predict card intervals",
  description: "Read-only scheduler predictions for Again, Hard, Good, and Easy on one card. Returns Anki's labels and interval amounts, not an exact due time or eligibility to review. Does not answer the card, change scheduling, or use custom states from the GUI reviewer. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    cardId: cardIdSchema,
    source: z.literal("scheduler"),
    answers: z.array(cardPredictionAnswerSchema).length(v1CardRatings.length),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function predictCardIntervals({ cardId }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const prediction = await readCardIntervalPrediction(cardId);
  return createToolResult(
    `Anki predicted four answer choices for Card ${cardId}. No answer was submitted.`,
    prediction,
  );
}
