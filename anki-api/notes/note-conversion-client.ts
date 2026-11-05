import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, stringIds, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { invalidAnkiV1Response } from "../v1/anki-v1-request.js";

export const conversionMappingSchema = z.strictObject({
  target: z.string().min(1).max(500),
  source: z.string().min(1).max(500).nullable(),
});
export type ConversionMapping = z.infer<typeof conversionMappingSchema>;

const conversionTypeSchema = v1EntitySummarySchema.extend({
  kind: z.enum(["normal", "cloze"]),
  fields: z.array(z.looseObject({ name: z.string().min(1) })).min(1),
  templates: z.array(z.looseObject({
    name: z.string().min(1), questionHtml: z.string(), answerHtml: z.string(),
  })).min(1),
  css: z.string(),
  modifiedAt: z.iso.datetime(),
}).loose();
export type ConversionNoteType = z.infer<typeof conversionTypeSchema>;

const nativePlanSchema = z.object({
  source: v1EntitySummarySchema,
  target: v1EntitySummarySchema,
  fields: z.array(conversionMappingSchema),
  templates: z.array(conversionMappingSchema),
  token: z.string().min(1),
});

export async function openNoteConversion(): Promise<V1AdapterContext & { profile: string }> {
  if (!useAnkiV1("notes.planConversion")) {
    throw new AnkiRequestError(
      "configuration", "notes.planConversion", "Note Type conversion requires ANKI_API_MODE=v1.", false,
    );
  }
  const ctx = await openV1Adapter({});
  if (ctx.profile === undefined) throw invalidAnkiV1Response("collection.get");
  return { ...ctx, profile: ctx.profile };
}

/** Reads the full native type and preserves ordered fields and templates. */
export async function readConversionNoteType(ctx: V1AdapterContext, id: number): Promise<ConversionNoteType> {
  const method = "noteTypes.get";
  const type = await ctx.request(method, { noteType: { id: String(id) } }, conversionTypeSchema);
  if (type.id !== id || new Set(type.fields.map(({ name }) => name)).size !== type.fields.length ||
      new Set(type.templates.map(({ name }) => name)).size !== type.templates.length) {
    throw invalidAnkiV1Response(method);
  }
  return type;
}

export async function readNativeConversionPlan(ctx: V1AdapterContext, sourceId: number, targetId: number) {
  const method = "notes.planConversion";
  const plan = await ctx.request(method, { source: { id: String(sourceId) }, target: { id: String(targetId) } }, nativePlanSchema);
  if (plan.source.id !== sourceId || plan.target.id !== targetId) throw invalidAnkiV1Response(method);
  return plan;
}

export async function convertNotesV1(
  ctx: V1AdapterContext, ids: number[], targetId: number,
  fields: ConversionMapping[], templates: ConversionMapping[], planToken: string,
): Promise<void> {
  const method = "notes.convert";
  const { changedCount } = await ctx.request(method, {
    ids: stringIds(ids), target: { id: String(targetId) }, fields, templates, planToken,
  }, z.object({ changedCount: z.number().int().nonnegative() }));
  if (changedCount !== ids.length) throw invalidAnkiV1Response(method);
}
