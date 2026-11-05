import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { deckNameKey, listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { getDeckPresetV1, listDeckPresetsV1, updateDeckPresetV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  presetDeckSchema, presetIdSchema, presetImpactLimit, presetNameSchema, presetPatchSchema,
  presetPreviewInput, presetPreviewOutput, settingChangeSchema,
} from "./deck-preset-schemas.js";
import { addApplyBlockers, dependentDecks, presetImpactHash, previewDecks, samePresetSetting, verifyPresetMutation } from "./deck-preset-utils.js";

const inputSchema = z.object({
  presetId: presetIdSchema,
  name: presetNameSchema.optional(),
  settings: presetPatchSchema.optional(),
  ...presetPreviewInput,
  confirmChanges: z.boolean().default(false),
}).refine(({ name, settings }) => name !== undefined || settings !== undefined, "Supply a new name or supported settings");

export const updateDeckPresetConfig = {
  title: "Update deck preset",
  description: "Previews a preset rename or a patch to learning, display order, or audio options, showing every deck using it. Requires an impact hash and explicit confirmation to apply. Does not request full FSRS rescheduling. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    ...presetPreviewOutput, presetId: presetIdSchema, beforeName: z.string(), afterName: z.string(),
    affectedDeckCount: z.number().int().nonnegative(), affectedDecks: z.array(presetDeckSchema).max(presetImpactLimit),
    settingChanges: z.array(settingChangeSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function updateDeckPreset(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.update");
  const [preset, decks, presets] = await Promise.all([
    getDeckPresetV1(ctx, input.presetId), listManagedDecks(ctx),
    input.name === undefined ? Promise.resolve([]) : listDeckPresetsV1(ctx),
  ]);
  const affected = dependentDecks(decks, preset.id);
  const afterName = input.name ?? preset.name;
  const entries = Object.entries(input.settings ?? {})
    .flatMap(([key, value]) => value === undefined ? [] : [[key, value] as const])
    .sort(([a], [b]) => a.localeCompare(b, "en"));
  const settingChanges = entries.filter(([key, value]) => !samePresetSetting(preset.settings[key], value))
    .map(([key, after]) => ({ key, before: preset.settings[key] ?? null, after }));
  const blockers: string[] = [];
  if (presets.some(({ id, name }) => id !== preset.id && deckNameKey(name) === deckNameKey(afterName))) {
    blockers.push("Another preset already has the proposed name.");
  }
  if (affected.length > presetImpactLimit) blockers.push(`The preset is used by more than ${presetImpactLimit} decks; the full impact cannot be reviewed.`);
  const impactHash = blockers.length === 0 ? presetImpactHash(ctx.profile, "update", preset, affected, { afterName, entries }) : null;
  addApplyBlockers(blockers, impactHash, input, input.confirmChanges, "confirmChanges");
  const result = {
    dryRun: input.dryRun, applied: false, verified: false, impactHash, blockers, presetId: preset.id,
    beforeName: preset.name, afterName, settingChanges, ...previewDecks(affected),
    warnings: ["All listed decks share this preset. Anki can update dependent learning state; full FSRS rescheduling is not requested. This preview does not predict individual due dates."],
  };
  if (blockers.length > 0 || input.dryRun) return createToolResult(
    blockers.length > 0 ? "No preset changes applied; resolve the blockers." : `Dry run: reviewed a preset used by ${affected.length} deck(s).`, result,
  );
  if (preset.name === afterName && settingChanges.length === 0) {
    return createToolResult("The preset already has the requested settings.", { ...result, verified: true });
  }
  await verifyPresetMutation(`update of preset ${preset.id}`, async () => {
    await updateDeckPresetV1(ctx, preset.id, {
      ...(afterName === preset.name ? {} : { name: afterName }),
      ...(settingChanges.length === 0 ? {} : { settings: Object.fromEntries(settingChanges.map(({ key, after }) => [key, after])) }),
    });
    const [saved, savedDecks] = await Promise.all([getDeckPresetV1(ctx, preset.id), listManagedDecks(ctx)]);
    if (saved.name !== afterName || entries.some(([key, value]) => !samePresetSetting(saved.settings[key], value)) ||
      !isDeepStrictEqual(dependentDecks(savedDecks, preset.id), affected)) {
      throw new Error("Saved preset settings or dependent deck assignments do not match the preview.");
    }
  });
  return createToolResult(`Updated and verified preset "${afterName}".`, { ...result, applied: true, verified: true });
}
