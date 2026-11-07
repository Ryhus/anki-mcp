import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { deckNameKey, listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { createDeckPresetV1, getDeckPresetV1, listDeckPresetsV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { presetDetailsSchema, presetIdSchema, presetNameSchema } from "./deck-preset-schemas.js";
import { verifyPresetMutation } from "./deck-preset-utils.js";

const inputSchema = z.object({
  name: presetNameSchema,
  cloneFromPresetId: presetIdSchema.optional().describe("Copy an existing preset instead of using Anki defaults"),
});

export const createDeckPresetConfig = {
  title: "Create deck preset",
  description: "Creates an unassigned deck preset from native defaults or an existing preset. Does not replace or assign a preset. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({ preset: presetDetailsSchema, verified: z.literal(true) }),
  annotations: NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS,
};

export async function createDeckPreset({ name, cloneFromPresetId }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.create");
  const presets = await listDeckPresetsV1(ctx);
  if (presets.some((preset) => deckNameKey(preset.name) === deckNameKey(name))) {
    throw new Error("A deck preset with that name already exists.");
  }
  if (cloneFromPresetId !== undefined && !presets.some(({ id }) => id === cloneFromPresetId)) {
    throw new Error("The source preset was not found.");
  }
  const preset = await verifyPresetMutation("preset creation", async () => {
    const created = await createDeckPresetV1(ctx, name, cloneFromPresetId);
    const [saved, decks] = await Promise.all([getDeckPresetV1(ctx, created.id), listManagedDecks(ctx)]);
    if (presets.some(({ id }) => id === saved.id) || saved.name !== name || decks.some(({ presetId }) => presetId === saved.id)) {
      throw new Error("The created preset was not verified as a new, unassigned preset.");
    }
    return saved;
  });
  return createToolResult(`Created and verified unassigned preset "${preset.name}" (ID: ${preset.id}).`, { preset, verified: true });
}
