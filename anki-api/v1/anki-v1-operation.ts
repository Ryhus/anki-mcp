import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { resolveAnkiRequestConfig, type AnkiRequestOptions } from "../anki-request-config.js";
import { AnkiRequestError } from "../anki-request-error.js";
import type { V1AdapterContext } from "./anki-v1-adapter-utils.js";
import { AnkiV1Error, ankiV1ErrorSchema, callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

const handleSchema = z.object({
  operationId: z.string().min(1), method: z.string(), session: z.string(),
});
const operationSchema = handleSchema.extend({
  state: z.enum(["queued", "running", "waitingForUser", "succeeded", "failed", "cancelled"]),
  result: z.unknown().optional(), error: ankiV1ErrorSchema.optional(),
});

export async function acceptV1Operation(ctx: V1AdapterContext, method: string, params: Record<string, unknown>): Promise<string> {
  const handle = await ctx.request(method, params, handleSchema);
  if (handle.method !== method || handle.session !== ctx.session) throw invalidAnkiV1Response(method);
  return handle.operationId;
}

/** Reads by operation ID, correlated with its original session even after a full sync changes the active one. */
export async function readV1Operation(method: string, operationId: string, session: string, options: AnkiRequestOptions = {}) {
  const operation = await callAnkiV1("operations.get", { operationId }, operationSchema, options);
  if (operation.operationId !== operationId || operation.method !== method || operation.session !== session) {
    throw invalidAnkiV1Response("operations.get");
  }
  return operation;
}

/** Polls the accepted operation without ever replaying or cancelling the write. */
export async function waitForV1Operation<T>(
  ctx: V1AdapterContext, method: string, operationId: string, schema: z.ZodType<T>,
): Promise<T> {
  const { timeoutMs } = resolveAnkiRequestConfig(method, ctx.options);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    if (ctx.options.signal?.aborted || remaining < 1) {
      throw new AnkiRequestError(
        ctx.options.signal?.aborted ? "cancelled" : "timeout",
        method, "Stopped waiting for the accepted operation; it may still complete.", true, { timeoutMs },
      );
    }
    const operation = await readV1Operation(method, operationId, ctx.session, {
      ...ctx.options, timeoutMs: remaining,
    });
    switch (operation.state) {
      case "succeeded": {
        const result = schema.safeParse(operation.result);
        if (!result.success || operation.error !== undefined) throw invalidAnkiV1Response("operations.get");
        return result.data;
      }
      case "failed":
      case "cancelled":
        if (operation.error === undefined || operation.result !== undefined) throw invalidAnkiV1Response("operations.get");
        throw new AnkiV1Error(method, operation.error.code);
      case "waitingForUser":
        throw new AnkiRequestError("invalid-response", method, "The accepted operation is waiting for user interaction in Anki.", true);
      default:
        if (operation.error !== undefined || operation.result !== undefined) throw invalidAnkiV1Response("operations.get");
        await delay(Math.max(1, Math.min(50, Math.floor(deadline - performance.now()))));
    }
  }
}
