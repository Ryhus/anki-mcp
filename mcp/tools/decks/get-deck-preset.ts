import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { getDeckPresetV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { presetDeckSchema, presetDetailsSchema, presetIdSchema, presetImpactLimit } from "./deck-preset-schemas.js";
import { dependentDecks } from "./deck-preset-utils.js";
import { deckIdSchema } from "./shared-schemas.js";

const inputSchema = z.object({
  presetId: presetIdSchema.optional(),
  deckId: deckIdSchema.optional().describe("Resolve the preset currently assigned to this normal deck"),
}).refine(({ presetId, deckId }) => (presetId === undefined) !== (deckId === undefined), "Supply exactly one of presetId or deckId");

export const getDeckPresetConfig = {
  title: "Get deck preset",
  description: "Reads a deck preset's settings and the decks that use it. Pass a preset ID or a normal deck ID. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    preset: presetDetailsSchema, assignedDeckCount: z.number().int().nonnegative(),
    assignedDecks: z.array(presetDeckSchema).max(presetImpactLimit),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function getDeckPreset({ presetId, deckId }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.get");
  const decks = await listManagedDecks(ctx);
  const id = presetId ?? decks.find((deck) => deck.id === deckId)?.presetId;
  if (id === undefined || id === null) throw new Error("The selected deck was not found or is filtered and has no preset.");
  const preset = await getDeckPresetV1(ctx, id);
  const assigned = dependentDecks(decks, id);
  return createToolResult(`Loaded preset "${preset.name}" used by ${assigned.length} deck(s).`, {
    preset, assignedDeckCount: assigned.length,
    assignedDecks: assigned.slice(0, presetImpactLimit).map(({ id, name }) => ({ id, name })),
  });
}
