import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { collectionSchedulerSchema, getV1Collection } from "../v1/anki-v1-context.js";
import { acceptV1Operation, readV1Operation } from "../v1/anki-v1-operation.js";
import { AnkiV1Error, invalidAnkiV1Response } from "../v1/anki-v1-request.js";

const infoMethod = "collection.get";
const refreshMethod = "collection.refresh";
export const syncMethod = "collection.sync";
export const integrityMethod = "collection.checkIntegrity";
export const undoMethod = "collection.undo";
export const collectionOperationMethodSchema = z.enum([syncMethod, integrityMethod, undoMethod]);
export type CollectionOperationMethod = z.infer<typeof collectionOperationMethodSchema>;
export type CollectionOperationProposal =
  | { method: typeof syncMethod; includeMedia: boolean }
  | { method: typeof integrityMethod | typeof undoMethod };
export type CollectionContext = V1AdapterContext & { profile: string };

export const collectionInfoSchema = z.object({
  profile: z.string().min(1), session: z.string().min(1), scheduler: collectionSchedulerSchema,
});
export const refreshTargetSchema = z.enum(["windows", "cachesAndWindows"]);
export const collectionOperationStateSchema = z.enum(["queued", "running", "waitingForUser", "succeeded", "failed", "cancelled", "unknown"]);
const syncResultSchema = z.object({ collectionComplete: z.boolean(), mediaComplete: z.boolean() });
const integrityResultSchema = z.object({ problems: z.array(z.string()), repaired: z.boolean() });
const undoResultSchema = z.object({ label: z.string(), changed: z.boolean() });
const resultSchemas = {
  [syncMethod]: syncResultSchema,
  [integrityMethod]: integrityResultSchema,
  [undoMethod]: undoResultSchema,
};
export const collectionOperationResultSchema = z.union([syncResultSchema, integrityResultSchema, undoResultSchema]);
export const collectionOperationErrorSchema = z.object({ code: z.number().int(), message: z.string() });
export interface CollectionOperationStatus {
  state: z.infer<typeof collectionOperationStateSchema>;
  result: z.infer<typeof collectionOperationResultSchema> | null;
  error: z.infer<typeof collectionOperationErrorSchema> | null;
}

export function requireCollectionV1(method: string): void {
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "Collection tools require ANKI_API_MODE=v1.", false);
  }
}

export async function readActiveCollection() {
  requireCollectionV1(infoMethod);
  const info = collectionInfoSchema.safeParse(await getV1Collection());
  if (!info.success) throw invalidAnkiV1Response(infoMethod);
  return info.data;
}

export async function openCollectionContext(method: string): Promise<CollectionContext> {
  requireCollectionV1(method);
  const ctx = await openV1Adapter({});
  if (ctx.profile === undefined) throw invalidAnkiV1Response(infoMethod);
  return { ...ctx, profile: ctx.profile };
}

export async function refreshCollectionWindows(target: z.infer<typeof refreshTargetSchema>) {
  const ctx = await openCollectionContext(refreshMethod);
  const { changed } = await ctx.request(refreshMethod, { target }, z.object({ changed: z.boolean() }));
  return { profile: ctx.profile, target, refreshed: changed };
}

export function startCollectionOperation(ctx: CollectionContext, proposal: CollectionOperationProposal) {
  const params = proposal.method === syncMethod ? { includeMedia: proposal.includeMedia } : {};
  return acceptV1Operation(ctx, proposal.method, params);
}

export async function readCollectionOperationStatus(
  operationId: string, method: CollectionOperationMethod, session: string,
): Promise<CollectionOperationStatus> {
  requireCollectionV1("operations.get");
  const { state, result, error } = await readV1Operation(method, operationId, session);
  if (state === "succeeded") {
    const parsed = resultSchemas[method].safeParse(result);
    if (!parsed.success || error !== undefined) throw invalidAnkiV1Response("operations.get");
    return { state, result: parsed.data, error: null };
  }
  if (state === "failed" || state === "cancelled") {
    if (result !== undefined || error === undefined) throw invalidAnkiV1Response("operations.get");
    return { state, result: null, error: { code: error.code, message: new AnkiV1Error(method, error.code).message } };
  }
  if (result !== undefined || error !== undefined) throw invalidAnkiV1Response("operations.get");
  return { state, result: null, error: null };
}
