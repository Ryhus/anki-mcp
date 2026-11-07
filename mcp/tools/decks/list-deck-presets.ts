import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listManagedDecks, openDeckManagement } from "../../../anki-api/decks/deck-management-client.js";
import { listDeckPresetsV1 } from "../../../anki-api/decks/deck-preset-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { presetSummarySchema } from "./deck-preset-schemas.js";

const inputSchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

export const listDeckPresetsConfig = {
  title: "List deck presets",
  description: "Lists Anki deck presets and how many normal decks use each one. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    total: z.number().int().nonnegative(), hasMore: z.boolean(),
    presets: z.array(presetSummarySchema.extend({ assignedDeckCount: z.number().int().nonnegative() })).max(100),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

export async function listDeckPresets({ offset, limit }: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openDeckManagement("deckPresets.list");
  const [presets, decks] = await Promise.all([listDeckPresetsV1(ctx), listManagedDecks(ctx)]);
  const counts = new Map<number, number>();
  for (const { presetId } of decks) {
    if (presetId !== null) counts.set(presetId, (counts.get(presetId) ?? 0) + 1);
  }
  const page = presets.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    .slice(offset, offset + limit).map((preset) => ({ ...preset, assignedDeckCount: counts.get(preset.id) ?? 0 }));
  return createToolResult(`Returned ${page.length} of ${presets.length} deck presets.`, {
    total: presets.length, hasMore: offset + page.length < presets.length, presets: page,
  });
}
