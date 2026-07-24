import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getAnkiDeckStats,
  getDeckNameMap,
} from "../../../anki-api/decks/deck-client.js";
import type {
  AnkiDeckStatsMap,
  AnkiDeckStats,
} from "../../../anki-api/decks/deck-types.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { compareByName, unique } from "./deck-utils.js";
import {
  deckNameSchema,
  deckStatsSchema,
  type DeckStats,
} from "./shared-schemas.js";

const getDeckStatsInputSchema = z.object({
  names: z
    .array(deckNameSchema)
    .min(1)
    .optional()
    .describe("Decks to inspect. Omit to return statistics for every deck."),
});

type GetDeckStatsInput = z.infer<typeof getDeckStatsInputSchema>;

export const getDeckStatsConfig = {
  title: "Get deck statistics",
  description:
    "Returns scheduler counts for selected decks, or for all decks when no names are provided. Fails if a requested deck does not exist.",
  inputSchema: getDeckStatsInputSchema,
  outputSchema: z.object({
    decks: z.array(deckStatsSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/**
 * Returns normalized scheduler counts without allowing a misspelled deck name
 * to create a new deck through AnkiConnect's internal ID lookup.
 */
export async function getDeckStats({
  names,
}: GetDeckStatsInput): Promise<CallToolResult> {
  const deckNameMap = await getDeckNameMap();
  const requestedNames = unique(names ?? Object.keys(deckNameMap));
  const missingNames = requestedNames.filter(
    (name) => deckNameMap[name] === undefined,
  );

  if (missingNames.length > 0) {
    throw new Error(`Decks not found: ${missingNames.join(", ")}`);
  }

  if (requestedNames.length === 0) {
    return createToolResult("No decks found.", { decks: [] });
  }

  const decks = normalizeDeckStats(await getAnkiDeckStats(requestedNames));
  const lines = decks.map(
    (deck) =>
      `- ${deck.name}: ${deck.newCount} new, ${deck.learningCount} learning, ${deck.reviewCount} review`,
  );

  return createToolResult(
    `Found statistics for ${decks.length} deck${decks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    { decks },
  );
}

function normalizeDeckStats(rawStats: AnkiDeckStatsMap): DeckStats[] {
  return Object.values(rawStats)
    .map(toDeckStats)
    .sort(compareByName);
}

function toDeckStats(stats: AnkiDeckStats): DeckStats {
  return {
    id: stats.deck_id,
    name: stats.name,
    newCount: stats.new_count,
    learningCount: stats.learn_count,
    reviewCount: stats.review_count,
    ...(stats.total_in_deck === undefined
      ? {}
      : { totalCards: stats.total_in_deck }),
  };
}
