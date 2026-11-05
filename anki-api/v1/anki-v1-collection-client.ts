import { z } from "zod";
import { callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";
import { getV1Collection, getV1WorkflowSession } from "./anki-v1-context.js";
import type { AnkiRequestOptions } from "../anki-request-config.js";

// Preserve numeric MCP IDs without ever rounding an upstream decimal string.
export const v1EntityIdSchema = z.string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(z.number().int().positive());

export const v1EntitySummarySchema = z.object({
  id: v1EntityIdSchema,
  name: z.string().min(1),
});

const entityListSchema = z.array(v1EntitySummarySchema);
const noteTypeDesignSchema = v1EntitySummarySchema.extend({
  css: z.string(),
  fields: z.array(z.object({ name: z.string().min(1) })).min(1),
  templates: z.array(z.object({
    name: z.string().min(1),
    questionHtml: z.string(),
    answerHtml: z.string(),
  })).min(1),
});
const noteTypeDesignWithSortFieldSchema = noteTypeDesignSchema.extend({
  sortField: z.string().min(1),
}).refine(({ fields, sortField }) => fields.some(({ name }) => name === sortField));

/** Normalizes v1 list records to the existing name-to-ID client contract. */
export async function getV1NameMap(method: "decks.list" | "noteTypes.list", session?: string, options?: AnkiRequestOptions): Promise<Record<string, number>> {
  const pinned = session ?? await getV1WorkflowSession();
  const entries = await callAnkiV1(method, pinned === undefined ? {} : { session: pinned }, entityListSchema, options);
  if (new Set(entries.map(({ name }) => name)).size !== entries.length ||
    new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw invalidAnkiV1Response(method);
  }
  return Object.fromEntries(entries.map(({ name, id }) => [name, id]));
}

export function getV1Tags(): Promise<string[]> {
  return callAnkiV1("tags.list", {}, z.array(z.string()));
}

/** Capture an Anki collection session so related requests cannot cross profiles. */
export async function getV1CollectionSession(): Promise<string> {
  const { session } = await getV1Collection();
  return session;
}

async function readV1NoteTypeDesign<T extends z.infer<typeof noteTypeDesignSchema>>(
  reference: string | number, schema: z.ZodType<T>, session?: string, options?: AnkiRequestOptions,
): Promise<T> {
  const method = "noteTypes.get";
  const pinned = session ?? await getV1WorkflowSession();
  const noteType = typeof reference === "number" ? { id: String(reference) } : { name: reference };
  const design = await callAnkiV1(method, {
    noteType, ...(pinned === undefined ? {} : { session: pinned }),
  }, schema, options);
  if ((typeof reference === "number" ? design.id !== reference : design.name !== reference) ||
    new Set(design.fields.map(({ name }) => name)).size !== design.fields.length ||
    new Set(design.templates.map(({ name }) => name)).size !== design.templates.length) {
    throw invalidAnkiV1Response(method);
  }
  return design;
}

/** Gets an ordered field/template snapshot and its CSS in a single exchange. */
export function getV1NoteTypeDesign(modelName: string, session?: string, options?: AnkiRequestOptions) {
  return readV1NoteTypeDesign(modelName, noteTypeDesignSchema, session, options);
}

/** Reads the sort field in the same native snapshot as the cloneable design. */
export function getV1NoteTypeDesignWithSortField(reference: string | number, session: string) {
  return readV1NoteTypeDesign(reference, noteTypeDesignWithSortFieldSchema, session);
}
