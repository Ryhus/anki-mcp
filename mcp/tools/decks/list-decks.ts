import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDeckNameMap } from "../../../anki-api/decks/deck-client.js";
import type { DeckNameMap } from "../../../anki-api/decks/deck-types.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { compareByName } from "./deck-utils.js";
import {
  deckSummarySchema,
  type DeckSummary,
} from "./shared-schemas.js";

export const listDecksConfig = {
  title: "List decks",
  description: "Lists all Anki decks with their IDs and hierarchy metadata.",
  outputSchema: z.object({
    decks: z.array(deckSummarySchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/**
 * Lists all decks and converts Anki's flat name-to-ID map into a sorted,
 * hierarchy-aware collection.
 */
export async function listDecks(): Promise<CallToolResult> {
  const decks = toDeckSummaries(await getDeckNameMap());
  const lines = decks.map((deck) => `- ${deck.name} (ID: ${deck.id})`);
  const message =
    decks.length === 0
      ? "No decks found."
      : `Found ${decks.length} deck${decks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;

  return createToolResult(message, { decks });
}

function toDeckSummaries(decks: DeckNameMap): DeckSummary[] {
  return Object.entries(decks)
    .map(([name, id]) => {
      const parentSeparatorIndex = name.lastIndexOf("::");

      return {
        id,
        name,
        parentName:
          parentSeparatorIndex === -1
            ? null
            : name.slice(0, parentSeparatorIndex),
        depth: name.split("::").length - 1,
      };
    })
    .sort(compareByName);
}
