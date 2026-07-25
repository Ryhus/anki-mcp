import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findAnkiCards } from "../../../anki-api/cards/card-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCards } from "./card-loader.js";
import { toCardSummary } from "./card-normalizers.js";
import { cardIdSchema, cardSummarySchema } from "./shared-schemas.js";

const searchCardsInputSchema = z.object({
  query: z
    .string()
    .max(2_000)
    .describe(
      'Native Anki search query, for example "deck:French is:due", "tag:verb", or "prop:lapses>3". An empty query searches all cards.',
    ),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

type SearchCardsInput = z.infer<typeof searchCardsInputSchema>;

export const searchCardsConfig = {
  title: "Search cards",
  description:
    "Searches cards with Anki's native query syntax and returns a bounded page of normalized scheduling summaries.",
  inputSchema: searchCardsInputSchema,
  outputSchema: z.object({
    query: z.string(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    cards: z.array(cardSummarySchema),
    missingCardIds: z.array(cardIdSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Searches cards without allowing a large collection to flood the MCP context. */
export async function searchCards({
  query,
  offset,
  limit,
}: SearchCardsInput): Promise<CallToolResult> {
  const matchingCardIds = await findAnkiCards(query);
  const pageCardIds = matchingCardIds.slice(offset, offset + limit);
  const { cards: loadedCards, missingCardIds } = await loadCards(pageCardIds);
  const cards = loadedCards.map(toCardSummary);
  const hasMore = offset + pageCardIds.length < matchingCardIds.length;

  return createToolResult(
    `Found ${matchingCardIds.length} matching card${matchingCardIds.length === 1 ? "" : "s"}; returned ${cards.length} from offset ${offset}${hasMore ? " with more results available" : ""}.`,
    {
      query,
      total: matchingCardIds.length,
      offset,
      returned: cards.length,
      hasMore,
      cards,
      missingCardIds,
    },
  );
}
