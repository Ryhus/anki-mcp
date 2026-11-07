import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { AnkiRequestOptions } from "../anki-request-config.js";
import { callAnkiV1 } from "./anki-v1-request.js";

export const collectionSchedulerSchema = z.enum(["sm2", "fsrs"]);
const collectionSchema = z.object({
  session: z.string().min(1),
  profile: z.string().min(1).optional(),
  scheduler: collectionSchedulerSchema.optional(),
});
type Collection = z.infer<typeof collectionSchema>;
const toolContext = new AsyncLocalStorage<{ pin: boolean; collection?: Promise<Collection> }>();

/** Lazily pins all v1 work in one MCP invocation to the same collection. */
export function withAnkiToolContext<T>(pin: boolean, run: () => Promise<T>): Promise<T> {
  return toolContext.run({ pin }, run);
}

export function getV1Collection(options?: AnkiRequestOptions): Promise<Collection> {
  const context = toolContext.getStore();
  if (context === undefined) return callAnkiV1("collection.get", {}, collectionSchema, options);
  return context.collection ??= callAnkiV1("collection.get", {}, collectionSchema, options);
}

/** Single-request reads can omit session admission; multi-step tools pin it. */
export async function getV1WorkflowSession(): Promise<string | undefined> {
  const context = toolContext.getStore();
  return context?.pin || context?.collection !== undefined ? (await getV1Collection()).session : undefined;
}
