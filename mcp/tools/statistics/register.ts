import type { McpServer } from "@modelcontextprotocol/server";
import { withToolErrorHandling } from "../../utils/tool-handler.js";
import { getStudyStats, getStudyStatsConfig } from "./get-study-stats.js";

export function registerStatisticsTools(server: McpServer): void {
  server.registerTool("get-study-stats", getStudyStatsConfig, withToolErrorHandling(getStudyStats));
}
