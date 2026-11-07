import { z } from "zod";

export const collectionOperationInputSchema = z.strictObject({
  operationId: z.string().min(1).max(256).describe("Operation ID returned by a collection tool on this MCP server."),
});
