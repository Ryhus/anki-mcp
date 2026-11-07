import type { CallToolResult } from "@modelcontextprotocol/server";
import { withAnkiToolContext } from "../../anki-api/v1/anki-v1-context.js";

export type ToolHandler<TArgs extends unknown[]> = (
  ...args: TArgs
) => Promise<CallToolResult>;

export function withToolErrorHandling<TArgs extends unknown[]>(
  handler: ToolHandler<TArgs>,
  pinCollection = true,
): ToolHandler<TArgs> {
  return (...args: TArgs): Promise<CallToolResult> => withAnkiToolContext(pinCollection, async () => {
    try {
      return await handler(...args);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${getErrorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}
