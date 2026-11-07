import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findAnkiCardPage, findAnkiCards } from "../../../anki-api/cards/card-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { resolveSearchPagination, searchPaginationShape, validateSearchPagination } from "../../utils/search-pagination.js";
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
  ...searchPaginationShape,
  limit: z.number().int().min(1).max(100).default(20),
}).superRefine(validateSearchPagination);

type SearchCardsInput = z.infer<typeof searchCardsInputSchema>;

export const searchCardsConfig = {
  title: "Search cards",
  description:
    "Searches cards with Anki's native query syntax. In v1 mode, defaults to a native cursor page. Request pagination: offset for an exact total or a numeric position.",
  inputSchema: searchCardsInputSchema,
  outputSchema: z.object({
    query: z.string(),
    total: z.number().int().nonnegative().nullable().describe("Exact count in offset mode; null in cursor mode."),
    offset: z.number().int().nonnegative().nullable().describe("Numeric offset; null in cursor mode."),
    nextCursor: z.string().nullable().optional().describe("Present in cursor mode. Null means the search is complete."),
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
  pagination,
  cursor,
  offset: requestedOffset,
  limit,
}: SearchCardsInput): Promise<CallToolResult> {
  if (resolveSearchPagination({ pagination, cursor, offset: requestedOffset }, "cards.search") === "cursor") {
    const { ids, nextCursor } = await findAnkiCardPage(query, limit, cursor);
    const { cards: loadedCards, missingCardIds } = await loadCards(ids);
    const cards = loadedCards.map(toCardSummary);
    return createToolResult(
      `Returned ${cards.length} matching card${cards.length === 1 ? "" : "s"}${nextCursor === null ? "." : " with more results available."}`,
      {
        query, total: null, offset: null, nextCursor, returned: cards.length,
        hasMore: nextCursor !== null, cards, missingCardIds,
      },
    );
  }
  const offset = requestedOffset ?? 0;
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
