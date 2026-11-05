import { z } from "zod";
import { collectionOperationMethodSchema } from "../../../anki-api/collection/collection-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import type { CollectionOperationRegistry } from "./operation-registry.js";
import { collectionOperationInputSchema } from "./shared-schemas.js";

export const cancelCollectionOperationConfig = {
  title: "Request cancellation of an Anki collection operation",
  description: "When the user asks to stop a sync, database check, or Undo, request cancellation of its operation ID from this running MCP server. Anki may refuse to stop a running operation. Acknowledgement is not completion or rollback; check get-collection-operation. Requires AnkiConnect v1.",
  inputSchema: collectionOperationInputSchema,
  outputSchema: z.object({
    operationId: collectionOperationInputSchema.shape.operationId,
    method: collectionOperationMethodSchema,
    profile: z.string(),
    requested: z.boolean().describe("Whether Anki acknowledged the cancellation request, not whether it stopped."),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function cancelCollectionOperation(
  registry: CollectionOperationRegistry, { operationId }: z.infer<typeof collectionOperationInputSchema>,
) {
  const result = await registry.cancel(operationId);
  const message = result.requested
    ? "Anki acknowledged the cancellation request. Check the same ID with get-collection-operation for the final result. Cancellation does not roll back completed changes."
    : "No cancellation was requested because the operation had already finished. Check get-collection-operation for its result.";
  return createToolResult(message, result);
}
