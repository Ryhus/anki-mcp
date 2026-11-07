import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { getStudyStats, getStudyStatsConfig } from "./get-study-stats.js";
import { getStudySummary, getStudySummaryConfig } from "./get-study-summary.js";

export function registerStatisticsTools(server: McpServer): void {
  server.registerTool("get-study-stats", getStudyStatsConfig, withToolErrorHandling(getStudyStats));
  server.registerTool("get-study-summary", getStudySummaryConfig, withToolErrorHandling(getStudySummary));
}
