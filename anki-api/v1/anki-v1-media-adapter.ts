import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { resolveAnkiRequestConfig } from "../anki-request-config.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { ackSchema, type V1AdapterContext, type V1Route } from "./anki-v1-adapter-utils.js";
import { retrieveV1MediaFile } from "./anki-v1-media-client.js";
import { AnkiV1Error, ankiV1ErrorSchema, callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

const storeMethod = "media.store";
const handleSchema = z.object({
  operationId: z.string().min(1), method: z.literal(storeMethod), session: z.string(),
});
const operationSchema = handleSchema.extend({
  state: z.enum(["queued", "running", "waitingForUser", "succeeded", "failed", "cancelled"]),
  result: z.unknown().optional(), error: ankiV1ErrorSchema.optional(),
});
const storedSchema = z.object({ status: z.literal("stored"), filename: z.string().min(1) });

/** Waits for a single accepted write, never resending it when polling fails. */
async function awaitStoredFilename(ctx: V1AdapterContext, operationId: string): Promise<string> {
  const { timeoutMs } = resolveAnkiRequestConfig(storeMethod, ctx.options);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    if (ctx.options.signal?.aborted || remaining < 1) {
      throw new AnkiRequestError(
        ctx.options.signal?.aborted ? "cancelled" : "timeout",
        storeMethod, "Stopped waiting for the accepted operation; the file may still be stored.", true, { timeoutMs },
      );
    }
    const operation = await callAnkiV1("operations.get", { operationId }, operationSchema, {
      ...ctx.options, timeoutMs: remaining,
    });
    if (operation.operationId !== operationId || operation.session !== ctx.session) {
      throw invalidAnkiV1Response("operations.get");
    }
    switch (operation.state) {
      case "succeeded": {
        const stored = storedSchema.safeParse(operation.result);
        if (!stored.success || operation.error !== undefined) throw invalidAnkiV1Response("operations.get");
        return stored.data.filename;
      }
      case "failed":
      case "cancelled":
        if (operation.error === undefined || operation.result !== undefined) throw invalidAnkiV1Response("operations.get");
        throw new AnkiV1Error(storeMethod, operation.error.code);
      case "waitingForUser":
        throw new AnkiRequestError("invalid-response", storeMethod, "The accepted media operation is waiting for user interaction in Anki.", true);
      default:
        if (operation.error !== undefined || operation.result !== undefined) throw invalidAnkiV1Response("operations.get");
        await delay(Math.max(1, Math.min(50, Math.floor(deadline - performance.now()))));
    }
  }
}

export const v1MediaRoutes = {
  retrieveMediaFile: ({ filename }, ctx) => retrieveV1MediaFile(filename as string, ctx.session, ctx.options),
  getMediaFilesNames: ({ pattern }, ctx) => ctx.request("media.list", { pattern }, z.array(z.string())),
  async deleteMediaFile({ filename }, ctx) {
    const method = "media.delete";
    if (!(await ctx.request(method, { filename }, ackSchema)).changed) throw invalidAnkiV1Response(method);
    return null;
  },
  async storeMediaFile({ filename, data, deleteExisting, rejectIfExists }, ctx) {
    const handle = await ctx.request(storeMethod, {
      filename, source: { data }, collision: deleteExisting === true ? "replace" : rejectIfExists === true ? "error" : "rename",
    }, handleSchema);
    if (handle.session !== ctx.session) throw invalidAnkiV1Response(storeMethod);
    try {
      return await awaitStoredFilename(ctx, handle.operationId);
    } catch (error) {
      throw new Error(
        `Anki accepted the media operation, but storage could not be confirmed. The file may exist or the operation may still complete; inspect Anki before retrying. ${error instanceof Error ? error.message : "Unknown operation failure."}`,
        { cause: error },
      );
    }
  },
} satisfies Record<string, V1Route>;
