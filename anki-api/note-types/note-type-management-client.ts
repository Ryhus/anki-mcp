import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, readV1Acks, searchV1IdPage, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { AnkiV1Error, invalidAnkiV1Response } from "../v1/anki-v1-request.js";
import type { AnkiCreateNoteTypeInput, AnkiCreateNoteTypeTemplate, AnkiNoteTypeTemplateMap } from "./note-type-types.js";

const updateMethod = "noteTypes.update";
export const deleteUnusedNoteTypeMethod = "noteTypes.deleteUnused";
export const replaceNoteTypeTextMethod = "noteTypes.replaceText";
export const noteTypeTextTargets = ["question", "answer", "css"] as const;
export type NoteTypeTextTarget = (typeof noteTypeTextTargets)[number];
type NoteTypeReference = { id: number } | { name: string };

const noteTypeFieldStateSchema = v1EntitySummarySchema.extend({
  fields: z.array(z.looseObject({ name: z.string().min(1) })).min(1),
  sortField: z.string().min(1),
}).refine(({ fields, sortField }) =>
  new Set(fields.map(({ name }) => name)).size === fields.length &&
  fields.some(({ name }) => name === sortField));

// Keep extra native metadata so changes to the reviewed definition invalidate deletion.
const noteTypeDeletionSnapshotSchema = noteTypeFieldStateSchema.safeExtend({
  kind: z.enum(["normal", "cloze"]),
  css: z.string(),
  templates: z.array(z.looseObject({
    name: z.string().min(1), questionHtml: z.string(), answerHtml: z.string(),
  })).min(1),
  modifiedAt: z.iso.datetime(),
}).loose();

const usageSchema = z.array(z.object({
  templateName: z.string(), questionFields: z.array(z.string()), answerFields: z.array(z.string()),
}));

const toNativeRef = (reference: NoteTypeReference) =>
  "id" in reference ? { id: String(reference.id) } : reference;

export const toNativeNoteTypeTemplate = ({ Name, Front, Back }: AnkiCreateNoteTypeTemplate) => ({
  name: Name, questionHtml: Front, answerHtml: Back,
});

/** Sends an optional sort field in the native create request, not as a second mutation. */
export async function createManagedNoteType(ctx: V1AdapterContext, {
  modelName, inOrderFields, cardTemplates, css, isCloze, sortField,
}: AnkiCreateNoteTypeInput) {
  const method = "noteTypes.create";
  const created = await ctx.request(method, {
    name: modelName, fields: inOrderFields.map((name) => ({ name })),
    templates: cardTemplates.map(toNativeNoteTypeTemplate), css, kind: isCloze ? "cloze" : "normal",
    ...(sortField === undefined ? {} : { sortField }),
  }, v1EntitySummarySchema);
  if (created.name !== modelName) throw invalidAnkiV1Response(method);
  return created;
}

export async function openNoteTypeManagement(method = updateMethod): Promise<V1AdapterContext> {
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError(
      "configuration", method, "This tool requires ANKI_API_MODE=v1.", false,
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

export function findManagedNoteTypeDeletionSnapshot(ctx: V1AdapterContext, id: number) {
  return findNoteType(ctx, { id }, noteTypeDeletionSnapshotSchema);
}

/** Searches Notes directly: a cardless Note still prevents deleting its Note Type. */
export async function hasNotesOfType(ctx: V1AdapterContext, id: number): Promise<boolean> {
  const { ids, nextCursor } = await searchV1IdPage(ctx, "notes.search", `mid:${id}`, 1);
  if (ids.length === 0 && nextCursor !== null) throw invalidAnkiV1Response("notes.search");
  return ids.length > 0;
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

/** Sends exactly one ID; Anki checks again that no Notes use the type. */
export async function deleteUnusedManagedNoteType(ctx: V1AdapterContext, id: number): Promise<void> {
  const method = deleteUnusedNoteTypeMethod;
  const [changed] = await readV1Acks(ctx, method, { noteTypes: [toNativeRef({ id })] }, 1);
  if (changed !== true) throw invalidAnkiV1Response(method);
}

/** Native, case-sensitive literal replacement on explicitly reviewed Note Types. */
export async function replaceManagedNoteTypeText(
  ctx: V1AdapterContext, ids: number[], find: string, replace: string, targets: NoteTypeTextTarget[],
): Promise<void> {
  if (ids.length === 0) return;
  const { changedCount } = await ctx.request(replaceNoteTypeTextMethod, {
    noteTypes: ids.map((id) => toNativeRef({ id })), find, replace, targets,
  }, z.object({ changedCount: z.number().int().nonnegative() }));
  if (changedCount !== ids.length) throw invalidAnkiV1Response(replaceNoteTypeTextMethod);
}
