import { z } from "zod";
import type { AnkiRequestOptions } from "../anki-request-config.js";
import { v1EntityIdSchema } from "./anki-v1-collection-client.js";
import { getV1Collection } from "./anki-v1-context.js";
import { AnkiV1Error, ankiV1ErrorSchema, callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

export interface V1AdapterContext {
  session: string;
  profile?: string | undefined;
  options: AnkiRequestOptions;
  request<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>;
}

export type V1Route = (params: Record<string, unknown>, ctx: V1AdapterContext) => Promise<unknown>;

export async function openV1Adapter(options: AnkiRequestOptions): Promise<V1AdapterContext> {
  const collection = await getV1Collection(options);
  return {
    ...collection, options,
    request: (method, params, schema) => callAnkiV1(method, { ...params, session: collection.session }, schema, options),
  };
}

export const ref = (name: string) => ({ name });
export const stringIds = (ids: readonly number[]) => ids.map(String);

/** Validates an indexed native batch; only explicitly allowed notFound items are missing. */
export async function readV1Items<T>(
  ctx: V1AdapterContext, method: string, params: Record<string, unknown>,
  count: number, schema: z.ZodType<T>, allowMissing: boolean,
): Promise<Array<T | null>> {
  const index = z.number().int().nonnegative();
  const { items } = await ctx.request(method, params, z.object({ items: z.array(z.union([
    z.strictObject({ index, result: schema }),
    z.strictObject({ index, error: ankiV1ErrorSchema }),
  ])) }));
  if (items.length !== count) throw invalidAnkiV1Response(method);
  const ordered = new Map<number, T | null>();
  for (const item of items) {
    if (item.index >= count || ordered.has(item.index)) throw invalidAnkiV1Response(method);
    if ("error" in item) {
      if (!allowMissing || item.error.code !== 1001) throw new AnkiV1Error(method, item.error.code);
      ordered.set(item.index, null);
    } else {
      ordered.set(item.index, item.result);
    }
  }
  return Array.from({ length: count }, (_, index) => ordered.get(index)!);
}

export const ackSchema = z.object({ changed: z.boolean() });

export async function readV1Acks(
  ctx: V1AdapterContext, method: string, params: Record<string, unknown>, count: number,
): Promise<boolean[]> {
  const items = await readV1Items(ctx, method, params, count, ackSchema, false);
  return items.map((item) => item!.changed);
}

const cursorSchema = z.string().min(1).nullable();
const idPageSchema = z.object({ ids: z.array(v1EntityIdSchema), nextCursor: cursorSchema });

/** Retains exact totals for existing full searches, including impact scans. */
export async function readAllV1Pages<T>(
  method: string,
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  // AnkiConnect caps a snapshot at one million IDs. These callers request
  // 1,000 per page; a broken endpoint must not keep a tool polling forever.
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const result = await page(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    if (seen.has(result.nextCursor)) throw invalidAnkiV1Response(method);
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw invalidAnkiV1Response(method);
}

export async function readV1IdPage(
  ctx: V1AdapterContext, method: string, params: Record<string, unknown>, limit: number,
) {
  const { ids, nextCursor } = await ctx.request(method, { ...params, limit }, idPageSchema);
  if (ids.length > limit || new Set(ids).size !== ids.length) throw invalidAnkiV1Response(method);
  return { ids, nextCursor };
}

export function searchV1IdPage(
  ctx: V1AdapterContext, method: "notes.search" | "cards.search", query: string, limit: number, cursor?: string,
) {
  return readV1IdPage(ctx, method, { query, ...(cursor === undefined ? {} : { cursor }) }, limit);
}

export async function searchAllV1Ids(ctx: V1AdapterContext, method: "notes.search" | "cards.search", query: string): Promise<number[]> {
  const found = await readAllV1Pages(method, async (cursor) => {
    const { ids, nextCursor } = await searchV1IdPage(ctx, method, query, 1_000, cursor);
    return { items: ids, nextCursor };
  });
  if (new Set(found).size !== found.length) throw invalidAnkiV1Response(method);
  return found;
}
