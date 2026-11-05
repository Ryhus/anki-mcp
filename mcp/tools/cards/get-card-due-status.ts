import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { cardDueFlagsSchema, readCardDueStatus } from "../../../anki-api/v1/anki-v1-scheduling-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { cardIdSchema } from "./shared-schemas.js";

const inputSchema = z.strictObject({
  cardId: cardIdSchema.describe("One existing card ID, for example from search-cards."),
  includeLearnAhead: z.boolean().default(false)
    .describe("Treat cards within Anki's learn-ahead window as available, without marking them due."),
});

export const getCardDueStatusConfig = {
  title: "Get card due status",
  description: "Checks one card's due time and per-card scheduling eligibility in Anki, optionally including learn-ahead. New cards can be available without being due. Does not account for daily deck limits, promise the card will be shown next, or change Anki. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: cardDueFlagsSchema.extend({
    cardId: cardIdSchema,
    includeLearnAhead: z.boolean().describe("Whether the request counted learn-ahead cards as available."),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getCardDueStatus({ cardId, includeLearnAhead }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const status = await readCardDueStatus(cardId, includeLearnAhead);
  return createToolResult(
    `Card ${cardId}: due now ${status.dueNow ? "yes" : "no"}, available ${status.available ? "yes" : "no"}, within learn-ahead window ${status.learnAhead ? "yes" : "no"}.`,
    status,
  );
}
