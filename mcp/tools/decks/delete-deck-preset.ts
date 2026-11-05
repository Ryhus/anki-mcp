import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { deleteUnusedDeckPresetV1, getDeckPresetV1, listDeckPresetsV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { presetDeckSchema, presetIdSchema, presetImpactLimit, presetPreviewInput, presetPreviewOutput } from "./deck-preset-schemas.js";
import { addApplyBlockers, dependentDecks, presetImpactHash, previewDecks, verifyPresetMutation } from "./deck-preset-utils.js";

const inputSchema = z.object({
  presetId: presetIdSchema,
  ...presetPreviewInput,
  confirmDeletion: z.boolean().default(false),
});

export const deleteDeckPresetConfig = {
  title: "Delete unused deck preset",
  description: "Previews deletion of one unused, non-Default deck preset. Never reassigns decks automatically. Requires an impact hash and explicit confirmation. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    ...presetPreviewOutput, presetId: presetIdSchema, presetName: z.string(),
    affectedDeckCount: z.number().int().nonnegative(), affectedDecks: z.array(presetDeckSchema).max(presetImpactLimit),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function deleteDeckPreset(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.delete");
  const [preset, decks] = await Promise.all([getDeckPresetV1(ctx, input.presetId), listManagedDecks(ctx)]);
  const affected = dependentDecks(decks, preset.id);
  const blockers: string[] = [];
  if (preset.id === 1) blockers.push("The built-in Default preset cannot be deleted.");
  if (affected.length > 0) blockers.push("The preset is still in use. Assign the affected decks to another preset before deleting it.");
  const impactHash = blockers.length === 0 ? presetImpactHash(ctx.profile, "delete", preset, affected, null) : null;
  addApplyBlockers(blockers, impactHash, input, input.confirmDeletion, "confirmDeletion");
  const result = {
    dryRun: input.dryRun, applied: false, verified: false, impactHash, blockers,
    presetId: preset.id, presetName: preset.name, ...previewDecks(affected),
    warnings: ["Deletion removes the preset, not decks or cards. No backup or automatic reassignment is created."],
  };
  if (blockers.length > 0 || input.dryRun) return createToolResult(
    blockers.length > 0 ? "No preset was deleted; resolve the blockers." : "Dry run: the unused preset can be deleted.", result,
  );

  await verifyPresetMutation(`deletion of preset ${preset.id}`, async () => {
    await deleteUnusedDeckPresetV1(ctx, preset.id);
    const [presets, savedDecks] = await Promise.all([listDeckPresetsV1(ctx), listManagedDecks(ctx)]);
    if (presets.some(({ id }) => id === preset.id) || dependentDecks(savedDecks, preset.id).length > 0) {
      throw new Error("The preset or a reference to it remains after deletion.");
    }
  });
  return createToolResult(`Deleted and verified unused preset ${preset.id}.`, { ...result, applied: true, verified: true });
}
