import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readStudySummary, studySummarySchema } from "../../../anki-api/statistics/study-stats-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckIdSchema } from "../decks/shared-schemas.js";

const inputSchema = z.strictObject({
  deckId: deckIdSchema.optional()
    .describe("Deck ID from list-decks. Includes child decks. Omit for the whole collection."),
});

export const getStudySummaryConfig = {
  title: "Get study summary",
  description: "Read-only structured Anki totals for the whole collection or one deck including its subdecks. Returns card and linked-note counts, recorded answers and time across available history, and current card categories. For today's workload use get-deck-stats. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("collection") }),
      z.object({ kind: z.literal("deck"), deckId: deckIdSchema, includesSubdecks: z.literal(true) }),
    ]),
    summary: studySummarySchema,
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getStudySummary({ deckId }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const summary = await readStudySummary(deckId);
  const scope = deckId === undefined ? { kind: "collection" }
    : { kind: "deck", deckId, includesSubdecks: true };
  const label = deckId === undefined ? "Collection" : `Deck ${deckId} including subdecks`;
  return createToolResult(
    `${label}: ${summary.cardCount} cards, ${summary.noteCount} linked notes, and ${summary.reviewCount} recorded answers.`,
    { scope, summary },
  );
}
