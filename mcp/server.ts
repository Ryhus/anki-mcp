#!/usr/bin/env node

import "dotenv/config";

import { startStdioServer } from "./stdio.js";

try {
  const handle = startStdioServer();
  const shutdown = (): void => {
    void handle.close().catch(reportFatalError);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error("Anki MCP server running on stdio");
} catch (error) {
  reportFatalError(error);
}

function reportFatalError(error: unknown): void {
  console.error("Fatal MCP server error:", error);
  process.exitCode = 1;
}
