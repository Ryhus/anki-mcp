import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function createToolResult(
  message: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}
