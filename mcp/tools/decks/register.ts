import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { assignDeckPreset, assignDeckPresetConfig } from "./assign-deck-preset.js";
import { createDeckPreset, createDeckPresetConfig } from "./create-deck-preset.js";
import { deleteDeckPreset, deleteDeckPresetConfig } from "./delete-deck-preset.js";
import { getDeckPreset, getDeckPresetConfig } from "./get-deck-preset.js";
import { listDeckPresets, listDeckPresetsConfig } from "./list-deck-presets.js";
import { updateDeckPreset, updateDeckPresetConfig } from "./update-deck-preset.js";
import { createDeck, createDeckConfig } from "./create-deck.js";
import {
  deleteDeckAndCards,
  deleteDeckAndCardsConfig,
} from "./delete-deck-and-cards.js";
import { getCardDecks, getCardDecksConfig } from "./get-card-decks.js";
import { getDeckStats, getDeckStatsConfig } from "./get-deck-stats.js";
import { listDecks, listDecksConfig } from "./list-decks.js";
import { renameDeck, renameDeckConfig } from "./rename-deck.js";
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
    withToolErrorHandling(listDecks, false),
  );
  server.registerTool(
    "create-deck",
    createDeckConfig,
    withToolErrorHandling(createDeck),
  );
  server.registerTool("rename-deck", renameDeckConfig, withToolErrorHandling(renameDeck));
  server.registerTool("list-deck-presets", listDeckPresetsConfig, withToolErrorHandling(listDeckPresets));
  server.registerTool("get-deck-preset", getDeckPresetConfig, withToolErrorHandling(getDeckPreset));
  server.registerTool("create-deck-preset", createDeckPresetConfig, withToolErrorHandling(createDeckPreset));
  server.registerTool("update-deck-preset", updateDeckPresetConfig, withToolErrorHandling(updateDeckPreset));
  server.registerTool("assign-deck-preset", assignDeckPresetConfig, withToolErrorHandling(assignDeckPreset));
  server.registerTool("delete-deck-preset", deleteDeckPresetConfig, withToolErrorHandling(deleteDeckPreset));
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
