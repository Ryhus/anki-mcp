import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import {
  getCardDetails,
  getCardDetailsConfig,
} from "./get-card-details.js";
import {
  getCardReviewHistory,
  getCardReviewHistoryConfig,
} from "./get-card-review-history.js";
import {
  resetCardsToNew,
  resetCardsToNewConfig,
} from "./reset-cards-to-new.js";
import { rescheduleCards, rescheduleCardsConfig } from "./reschedule-cards.js";
import { searchCards, searchCardsConfig } from "./search-cards.js";
import { setCardFlag, setCardFlagConfig } from "./set-card-flag.js";
import {
  setCardSuspension,
  setCardSuspensionConfig,
} from "./set-card-suspension.js";
import {
  startCardRelearning,
  startCardRelearningConfig,
} from "./start-card-relearning.js";

/** Registers the LLM-facing card tools and their schemas with the MCP server. */
export function registerCardTools(server: McpServer): void {
  server.registerTool(
    "search-cards",
    searchCardsConfig,
    withToolErrorHandling(searchCards),
  );
  server.registerTool(
    "get-card-details",
    getCardDetailsConfig,
    withToolErrorHandling(getCardDetails),
  );
  server.registerTool(
    "get-card-review-history",
    getCardReviewHistoryConfig,
    withToolErrorHandling(getCardReviewHistory),
  );
  server.registerTool(
    "set-card-suspension",
    setCardSuspensionConfig,
    withToolErrorHandling(setCardSuspension),
  );
  server.registerTool(
    "set-card-flag",
    setCardFlagConfig,
    withToolErrorHandling(setCardFlag),
  );
  server.registerTool(
    "reschedule-cards",
    rescheduleCardsConfig,
    withToolErrorHandling(rescheduleCards),
  );
  server.registerTool(
    "reset-cards-to-new",
    resetCardsToNewConfig,
    withToolErrorHandling(resetCardsToNew),
  );
  server.registerTool(
    "start-card-relearning",
    startCardRelearningConfig,
    withToolErrorHandling(startCardRelearning),
  );
}
