import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { assignDeckPresetV1, getDeckPresetV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { presetDeckSchema, presetIdSchema, presetImpactLimit, presetPreviewInput, presetPreviewOutput } from "./deck-preset-schemas.js";
import { addApplyBlockers, presetImpactHash, verifyPresetMutation } from "./deck-preset-utils.js";
import { deckIdSchema } from "./shared-schemas.js";

const inputSchema = z.object({
  presetId: presetIdSchema,
  deckIds: z.array(deckIdSchema).min(1).max(presetImpactLimit).describe("Explicit normal deck IDs; descendants are not automatically included"),
  ...presetPreviewInput,
  confirmChanges: z.boolean().default(false),
});

export const assignDeckPresetConfig = {
  title: "Assign deck preset",
  description: "Previews assigning a preset to explicitly selected normal decks, without adding descendants or requesting full FSRS rescheduling. Requires an impact hash and explicit confirmation. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    ...presetPreviewOutput, presetId: presetIdSchema, presetName: z.string(),
    changes: z.array(presetDeckSchema.extend({ beforePresetId: presetIdSchema, afterPresetId: presetIdSchema })).max(presetImpactLimit),
    unchangedDeckIds: z.array(deckIdSchema),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function assignDeckPreset(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.assign");
  const [preset, decks] = await Promise.all([getDeckPresetV1(ctx, input.presetId), listManagedDecks(ctx)]);
  const ids = [...new Set(input.deckIds)].sort((a, b) => a - b);
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const selected = ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const normal = selected.filter((deck) => deck.presetId !== null);
  const blockers: string[] = [];
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) blockers.push(`Deck IDs not found: ${missing.join(", ")}.`);
  if (normal.length !== selected.length) blockers.push("Filtered decks do not have presets; the entire selection was withheld.");
  const changes = normal.flatMap(({ id, name, presetId }) => presetId === preset.id ? [] : [{
    id, name, beforePresetId: presetId!, afterPresetId: preset.id,
  }]);
  const unchangedDeckIds = normal.filter(({ presetId }) => presetId === preset.id).map(({ id }) => id);
  const impactHash = blockers.length === 0 ? presetImpactHash(ctx.profile, "assign", preset, selected, ids) : null;
  addApplyBlockers(blockers, impactHash, input, input.confirmChanges, "confirmChanges");
  const result = {
    dryRun: input.dryRun, applied: false, verified: false, impactHash, blockers,
    presetId: preset.id, presetName: preset.name, changes, unchangedDeckIds,
    warnings: ["Anki may update dependent learning state for these decks. No full FSRS rescheduling was requested. Assignment is not an atomic batch."],
  };
  if (blockers.length > 0 || input.dryRun) return createToolResult(
    blockers.length > 0 ? "No preset assignments applied; resolve the blockers." : `Dry run: ${changes.length} deck(s) would change preset.`, result,
  );
  if (changes.length === 0) return createToolResult("All selected decks already use the preset.", { ...result, verified: true });

  await verifyPresetMutation(`assignment of preset ${preset.id}`, async () => {
    await assignDeckPresetV1(ctx, changes.map(({ id }) => id), preset.id);
    const [savedDecks, savedPreset] = await Promise.all([listManagedDecks(ctx), getDeckPresetV1(ctx, preset.id)]);
    const saved = new Map(savedDecks.map((deck) => [deck.id, deck]));
    if (savedPreset.name !== preset.name || !isDeepStrictEqual(savedPreset.settings, preset.settings) ||
        selected.some(({ id, name }) => saved.get(id)?.name !== name || saved.get(id)?.presetId !== preset.id)) {
      throw new Error("Saved deck assignments or target preset settings do not match the preview.");
    }
  });
  return createToolResult(`Assigned and verified preset ${preset.id} on ${changes.length} deck(s).`, { ...result, applied: true, verified: true });
}
