import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler<TArgs extends unknown[]> = (
  ...args: TArgs
) => Promise<CallToolResult>;

export function withToolErrorHandling<TArgs extends unknown[]>(
  handler: ToolHandler<TArgs>,
): ToolHandler<TArgs> {
  return async (...args: TArgs): Promise<CallToolResult> => {
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
  };
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
