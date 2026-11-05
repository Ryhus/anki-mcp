import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { AnkiV1Error, invalidAnkiV1Response } from "../v1/anki-v1-request.js";
import type { AnkiNoteTypeTemplateMap } from "./note-type-types.js";

const updateMethod = "noteTypes.update";
type NoteTypeReference = { id: number } | { name: string };

const noteTypeFieldStateSchema = v1EntitySummarySchema.extend({
  fields: z.array(z.object({ name: z.string().min(1) })).min(1),
  sortField: z.string().min(1),
}).refine(({ fields, sortField }) =>
  new Set(fields.map(({ name }) => name)).size === fields.length &&
  fields.some(({ name }) => name === sortField));

const usageSchema = z.array(z.object({
  templateName: z.string(), questionFields: z.array(z.string()), answerFields: z.array(z.string()),
}));

const toNativeRef = (reference: NoteTypeReference) =>
  "id" in reference ? { id: String(reference.id) } : reference;

export async function openNoteTypeManagement(): Promise<V1AdapterContext> {
  if (!useAnkiV1(updateMethod)) {
    throw new AnkiRequestError(
      "configuration", updateMethod, "This tool requires ANKI_API_MODE=v1.", false,
    );
  }
  return openV1Adapter({});
}

async function findNoteType<T extends { id: number }>(
  ctx: V1AdapterContext, reference: NoteTypeReference, schema: z.ZodType<T>,
): Promise<T | null> {
  const method = "noteTypes.get";
  try {
    const type = await ctx.request(method, { noteType: toNativeRef(reference) }, schema);
    if ("id" in reference && type.id !== reference.id) throw invalidAnkiV1Response(method);
    return type;
  } catch (error) {
    if (error instanceof AnkiV1Error && error.code === 1001) return null;
    throw error;
  }
}

/** A name lookup uses Anki's native comparison rules. */
export function findManagedNoteType(ctx: V1AdapterContext, reference: NoteTypeReference) {
  return findNoteType(ctx, reference, v1EntitySummarySchema);
}

export function findManagedNoteTypeFieldState(ctx: V1AdapterContext, reference: NoteTypeReference) {
  return findNoteType(ctx, reference, noteTypeFieldStateSchema);
}

/** Preserves the existing field-usage contract: answer-only fields exclude question fields. */
export async function getManagedNoteTypeTemplateFields(
  ctx: V1AdapterContext, reference: NoteTypeReference,
): Promise<AnkiNoteTypeTemplateMap> {
  const method = "noteTypes.getTemplateUsage";
  const rows = await ctx.request(method, { noteType: toNativeRef(reference) }, usageSchema);
  if (new Set(rows.map(({ templateName }) => templateName)).size !== rows.length) {
    throw invalidAnkiV1Response(method);
  }
  return Object.fromEntries(rows.map(({ templateName, questionFields, answerFields }) => [
    templateName, [questionFields, answerFields.filter((field) => !questionFields.includes(field))],
  ]));
}

/** Changes only the name of the type with the reviewed stable ID. */
export async function renameManagedNoteType(ctx: V1AdapterContext, id: number, name: string): Promise<void> {
  const saved = await ctx.request(updateMethod, {
    noteType: toNativeRef({ id }), patch: { name },
  }, v1EntitySummarySchema);
  if (saved.id !== id || saved.name !== name) throw invalidAnkiV1Response(updateMethod);
}

/** Changes only the Browser sort field, not the order or contents of fields. */
export async function setManagedNoteTypeSortField(ctx: V1AdapterContext, id: number, sortField: string): Promise<void> {
  const saved = await ctx.request(updateMethod, {
    noteType: toNativeRef({ id }), patch: { sortField },
  }, noteTypeFieldStateSchema);
  if (saved.id !== id || saved.sortField !== sortField) throw invalidAnkiV1Response(updateMethod);
}
