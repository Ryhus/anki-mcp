import { z } from "zod";
import { callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

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

/** Normalizes v1 list records to the existing name-to-ID client contract. */
export async function getV1NameMap(method: "decks.list" | "noteTypes.list"): Promise<Record<string, number>> {
  const entries = await callAnkiV1(method, {}, entityListSchema);
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
  const { session } = await callAnkiV1("collection.get", {}, z.object({ session: z.string().min(1) }));
  return session;
}

/** Gets an ordered field/template snapshot and its CSS in a single exchange. */
export async function getV1NoteTypeDesign(modelName: string) {
  const method = "noteTypes.get";
  const design = await callAnkiV1(method, { noteType: { name: modelName } }, noteTypeDesignSchema);
  if (design.name !== modelName ||
    new Set(design.fields.map(({ name }) => name)).size !== design.fields.length ||
    new Set(design.templates.map(({ name }) => name)).size !== design.templates.length) {
    throw invalidAnkiV1Response(method);
  }
  return design;
}
