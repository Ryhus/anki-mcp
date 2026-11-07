import { z } from "zod";
import type { DeckManagementContext } from "./deck-management-client.js";
import { ackSchema } from "../v1/anki-v1-adapter-utils.js";
import { v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { acceptV1Operation, waitForV1Operation } from "../v1/anki-v1-operation.js";
import { AnkiV1Error, ankiV1ErrorSchema, invalidAnkiV1Response } from "../v1/anki-v1-request.js";

export const presetSettingValueSchema = z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]);
export type PresetSettingValue = z.infer<typeof presetSettingValueSchema>;
export const deckPresetSchema = v1EntitySummarySchema.extend({
  settings: z.record(z.string(), presetSettingValueSchema),
  modifiedAt: z.iso.datetime(),
});
export type DeckPreset = z.infer<typeof deckPresetSchema>;

export async function listDeckPresetsV1(ctx: DeckManagementContext) {
  const method = "deckPresets.list";
  const presets = await ctx.request(method, {}, z.array(v1EntitySummarySchema));
  if (new Set(presets.map(({ id }) => id)).size !== presets.length) throw invalidAnkiV1Response(method);
  return presets;
}

const idRef = (id: number) => ({ id: String(id) });

export async function getDeckPresetV1(ctx: DeckManagementContext, presetId: number): Promise<DeckPreset> {
  const method = "deckPresets.get";
  const preset = await ctx.request(method, { preset: idRef(presetId) }, deckPresetSchema);
  if (preset.id !== presetId) throw invalidAnkiV1Response(method);
  return preset;
}

export async function createDeckPresetV1(ctx: DeckManagementContext, name: string, cloneFromPresetId?: number): Promise<DeckPreset> {
  const method = "deckPresets.create";
  const preset = await ctx.request(method, {
    name, ...(cloneFromPresetId === undefined ? {} : { cloneFrom: idRef(cloneFromPresetId) }),
  }, deckPresetSchema);
  if (preset.name !== name) throw invalidAnkiV1Response(method);
  return preset;
}

export async function updateDeckPresetV1(
  ctx: DeckManagementContext, presetId: number, patch: { name?: string; settings?: Record<string, PresetSettingValue> },
): Promise<DeckPreset> {
  const method = "deckPresets.update";
  const id = await acceptV1Operation(ctx, method, { preset: idRef(presetId), ...patch, rescheduleFsrs: false });
  const result = await waitForV1Operation(ctx, method, id, deckPresetSchema);
  if (result.id !== presetId) throw invalidAnkiV1Response(method);
  return result;
}

const index = z.number().int().nonnegative();
const assignmentSchema = z.object({ items: z.array(z.union([
  z.strictObject({ index, result: ackSchema }),
  z.strictObject({ index, error: ankiV1ErrorSchema }),
])) });

export async function assignDeckPresetV1(ctx: DeckManagementContext, deckIds: number[], presetId: number): Promise<void> {
  const method = "deckPresets.assign";
  const id = await acceptV1Operation(ctx, method, { decks: deckIds.map(idRef), preset: idRef(presetId), rescheduleFsrs: false });
  const { items } = await waitForV1Operation(ctx, method, id, assignmentSchema);
  if (items.length !== deckIds.length || items.some((item) => item.index >= deckIds.length) ||
      new Set(items.map((item) => item.index)).size !== items.length) {
    throw invalidAnkiV1Response(method);
  }
  const rejected = items.find((item) => "error" in item);
  if (rejected && "error" in rejected) throw new AnkiV1Error(method, rejected.error.code);
}

export async function deleteUnusedDeckPresetV1(ctx: DeckManagementContext, presetId: number): Promise<void> {
  const method = "deckPresets.delete";
  // Deliberately omit replacement. Anki refuses if a deck acquired this preset after preflight.
  const id = await acceptV1Operation(ctx, method, { preset: idRef(presetId) });
  if (!(await waitForV1Operation(ctx, method, id, ackSchema)).changed) throw invalidAnkiV1Response(method);
}
