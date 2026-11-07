import { z } from "zod";
import {
  collectionInfoSchema, collectionOperationErrorSchema, collectionOperationMethodSchema, collectionOperationResultSchema,
  collectionOperationStateSchema, readActiveCollection, refreshCollectionWindows, refreshTargetSchema, requireCollectionV1, syncMethod, undoMethod,
} from "../../../anki-api/collection/collection-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import type { CollectionOperationRegistry } from "./operation-registry.js";
import { collectionOperationInputSchema } from "./shared-schemas.js";

export const getCollectionInfoConfig = {
  title: "Get active Anki collection information",
  description: "Read the active profile, scheduler, and opaque collection session. Does not read Notes or Cards. Requires AnkiConnect v1.",
  inputSchema: z.strictObject({}),
  outputSchema: collectionInfoSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getCollectionInfo() {
  return createToolResult("Read the active Anki collection.", await readActiveCollection());
}

export const getCollectionOperationConfig = {
  title: "Get Anki collection operation status",
  description: "Check a submitted sync, database check, or Undo without starting another. If waitingForUser, use Anki's UI and check the same operation ID again. Requires AnkiConnect v1.",
  inputSchema: collectionOperationInputSchema,
  outputSchema: z.object({
    operationId: collectionOperationInputSchema.shape.operationId, method: collectionOperationMethodSchema, profile: z.string(),
    state: collectionOperationStateSchema, result: collectionOperationResultSchema.nullable(), error: collectionOperationErrorSchema.nullable(),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getCollectionOperation(registry: CollectionOperationRegistry, { operationId }: z.infer<typeof collectionOperationInputSchema>) {
  requireCollectionV1("operations.get");
  const status = await registry.inspect(operationId);
  let message = `Anki collection operation status: ${status.state}.`;
  if (status.state === "waitingForUser") {
    message = status.method === syncMethod
      ? "Anki is waiting for your decision in the desktop app. Review its Upload, Download, or Cancel options yourself, then check this same operation ID. Do not start another sync."
      : "Anki is waiting for you in the desktop app. Respond there, then check this same operation ID.";
  } else if (status.method === undoMethod && status.state === "failed" && status.error?.code === 1009) {
    message = "Anki has nothing to undo.";
  } else if (status.error !== null) {
    message += ` ${status.error.message}`;
  }
  return createToolResult(message, status);
}

const refreshInput = z.strictObject({
  target: refreshTargetSchema.default("windows").describe("Refresh windows, or invalidate the supported note type cache first."),
});

export const refreshCollectionConfig = {
  title: "Refresh Anki collection windows",
  description: "Refresh open Anki windows, optionally clearing the supported Note Type cache first. Does not reopen the collection, sync, or repair data. Requires AnkiConnect v1.",
  inputSchema: refreshInput,
  outputSchema: z.object({ profile: z.string(), target: refreshTargetSchema, refreshed: z.boolean() }),
  annotations: { ...READ_ONLY_TOOL_ANNOTATIONS, readOnlyHint: false },
};

export async function refreshCollection(registry: CollectionOperationRegistry, { target }: z.infer<typeof refreshInput>) {
  registry.assertIdle();
  const result = await refreshCollectionWindows(target);
  return createToolResult(result.refreshed ? "Refreshed Anki windows." : "Anki did not report a window refresh.", result);
}
