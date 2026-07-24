import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { createDeck, createDeckConfig } from "./create-deck.js";
import {
  deleteDeckAndCards,
  deleteDeckAndCardsConfig,
} from "./delete-deck-and-cards.js";
import { getCardDecks, getCardDecksConfig } from "./get-card-decks.js";
import { getDeckStats, getDeckStatsConfig } from "./get-deck-stats.js";
import { listDecks, listDecksConfig } from "./list-decks.js";
import {
  moveCardsToDeck,
  moveCardsToDeckConfig,
} from "./move-cards-to-deck.js";

/**
 * Registers the LLM-facing deck tools and their schemas with the MCP server.
 */
export function registerDeckTools(server: McpServer): void {
  server.registerTool(
    "list-decks",
    listDecksConfig,
    withToolErrorHandling(listDecks),
  );
  server.registerTool(
    "create-deck",
    createDeckConfig,
    withToolErrorHandling(createDeck),
  );
  server.registerTool(
    "get-deck-stats",
    getDeckStatsConfig,
    withToolErrorHandling(getDeckStats),
  );
  server.registerTool(
    "get-card-decks",
    getCardDecksConfig,
    withToolErrorHandling(getCardDecks),
  );
  server.registerTool(
    "move-cards-to-deck",
    moveCardsToDeckConfig,
    withToolErrorHandling(moveCardsToDeck),
  );
  server.registerTool(
    "delete-deck-and-cards",
    deleteDeckAndCardsConfig,
    withToolErrorHandling(deleteDeckAndCards),
  );
}
