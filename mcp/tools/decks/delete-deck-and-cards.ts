import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  deleteAnkiDeck,
  getDeckNameMap,
} from "../../../anki-api/decks/deck-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckIdSchema, deckNameSchema } from "./shared-schemas.js";

const deleteDeckInputSchema = z.object({
  name: deckNameSchema.describe(
    "Exact name of the deck to permanently delete with all of its cards",
  ),
});

type DeleteDeckInput = z.infer<typeof deleteDeckInputSchema>;

export const deleteDeckAndCardsConfig = {
  title: "Delete deck and cards",
  description:
    "Permanently deletes one deck and all cards it contains. This action cannot be undone through this MCP server.",
  inputSchema: deleteDeckInputSchema,
  outputSchema: z.object({
    deletedDeck: z.object({
      id: deckIdSchema,
      name: z.string(),
    }),
    deletedCards: z.literal(true),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/**
 * Permanently deletes one existing deck and all cards it contains.
 */
export async function deleteDeckAndCards({
  name,
}: DeleteDeckInput): Promise<CallToolResult> {
  const decks = await getDeckNameMap();
  const id = decks[name];

  if (id === undefined) {
    throw new Error(`Deck not found: ${name}`);
  }

  await deleteAnkiDeck(name);

  return createToolResult(`Deleted deck "${name}" and all of its cards.`, {
    deletedDeck: { id, name },
    deletedCards: true,
  });
}
