import { z } from "zod";
import {
  type CollectionOperationProposal, collectionOperationMethodSchema, integrityMethod, openCollectionContext, syncMethod, undoMethod,
} from "../../../anki-api/collection/collection-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { type CollectionOperationRegistry, confirmationLifetimeSeconds } from "./operation-registry.js";

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const confirmationInput = z.strictObject({
  dryRun: z.boolean().default(true).describe("Review the active profile and proposal without running the operation."),
  confirmationToken: tokenSchema.optional().describe("Short-lived, one-use token returned by this tool's preview."),
  confirm: z.boolean().default(false).describe("Set true only after the user approves the reviewed collection operation."),
});
const syncInput = confirmationInput.extend({
  includeMedia: z.boolean().default(true).describe("Request media sync, if enabled in the active profile."),
});
const guardedOutput = z.object({
  state: z.enum(["preview", "submitted"]),
  profile: z.string(),
  method: collectionOperationMethodSchema,
  includeMedia: z.boolean().nullable().describe("Requested media option for sync; null for other operations."),
  confirmationToken: tokenSchema.nullable(),
  expiresInSeconds: z.number().int().positive().nullable(),
  operationId: z.string().min(1).max(256).nullable(),
  warnings: z.array(z.string()),
});
const guardedConfig = {
  inputSchema: confirmationInput, outputSchema: guardedOutput, annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export const syncCollectionConfig = {
  ...guardedConfig,
  title: "Synchronize the active Anki collection",
  description: "Preview or explicitly confirm a sync with Anki's configured server. A full sync may require the user to choose Upload or Download in Anki. Returns an operation ID, not completion. Requires AnkiConnect v1.",
  inputSchema: syncInput,
  annotations: { ...guardedConfig.annotations, openWorldHint: true },
};
export const checkCollectionIntegrityConfig = {
  ...guardedConfig,
  title: "Check and repair the active Anki database",
  description: "Preview or explicitly confirm Anki's native Check Database operation. It can repair data and clear the Undo history; the preview does not check the database. Requires AnkiConnect v1.",
};
export const undoCollectionActionConfig = {
  ...guardedConfig,
  title: "Undo Anki's current undoable action",
  description: "Preview or explicitly confirm a single native Undo. AnkiConnect cannot preview or select the undo entry; Undo can revert a manual action, not necessarily a change made through MCP. Never use it as automatic rollback. Requires AnkiConnect v1.",
};

const warningsByMethod = {
  [syncMethod]: [
    "Sync can send or receive data for the entire active collection. Media is included only if requested and enabled in Anki.",
    "Preview does not contact the sync server. If Anki requires full sync, choose the direction yourself in Anki and check the same operation ID.",
  ],
  [integrityMethod]: [
    "Preview does not run Check Database or predict repairs. Check Database can modify data and clear Anki's Undo history.",
    "This tool does not create a backup.",
  ],
  [undoMethod]: [
    "The API cannot preview or select the undo entry. The actual entry is reported only after Undo completes.",
    "Undo affects the current undoable action, which could be a manual change. Do not edit or review between preview and confirmation.",
  ],
};

async function run(
  registry: CollectionOperationRegistry, proposal: CollectionOperationProposal, input: z.infer<typeof confirmationInput>,
) {
  if (!input.dryRun && (!input.confirm || input.confirmationToken === undefined)) {
    throw new Error("Applying requires confirm: true and the confirmationToken from a fresh preview.");
  }
  registry.assertIdle();
  const ctx = await openCollectionContext(proposal.method);
  const base = {
    profile: ctx.profile, method: proposal.method, includeMedia: proposal.method === syncMethod ? proposal.includeMedia : null,
    warnings: warningsByMethod[proposal.method],
  };
  if (input.dryRun) {
    const confirmationToken = registry.issue(ctx, proposal);
    return createToolResult("Dry run: reviewed the request and active profile. No operation was started.", {
      ...base, state: "preview", confirmationToken, expiresInSeconds: confirmationLifetimeSeconds, operationId: null,
    });
  }
  const operationId = await registry.submit(ctx, proposal, input.confirmationToken!);
  return createToolResult("Anki accepted the operation. Use get-collection-operation with this ID to check completion. Do not resubmit.", {
    ...base, state: "submitted", confirmationToken: null, expiresInSeconds: null, operationId,
  });
}

export function syncCollection(registry: CollectionOperationRegistry, input: z.infer<typeof syncInput>) {
  return run(registry, { method: syncMethod, includeMedia: input.includeMedia }, input);
}
export function checkCollectionIntegrity(registry: CollectionOperationRegistry, input: z.infer<typeof confirmationInput>) {
  return run(registry, { method: integrityMethod }, input);
}
export function undoCollectionAction(registry: CollectionOperationRegistry, input: z.infer<typeof confirmationInput>) {
  return run(registry, { method: undoMethod }, input);
}
