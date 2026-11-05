import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, type V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { v1EntityIdSchema, v1EntitySummarySchema } from "../v1/anki-v1-collection-client.js";
import { invalidAnkiV1Response } from "../v1/anki-v1-request.js";

const managedDeckSchema = v1EntitySummarySchema.extend({
  kind: z.enum(["normal", "filtered"]),
  presetId: v1EntityIdSchema.nullable(),
});
export type ManagedDeck = z.infer<typeof managedDeckSchema>;
export type DeckManagementContext = V1AdapterContext & { profile: string };

/** New deck management tools require v1 instead of emulating native operations. */
export async function openDeckManagement(method: string): Promise<DeckManagementContext> {
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "This tool requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  if (ctx.profile === undefined) throw invalidAnkiV1Response("collection.get");
  return { ...ctx, profile: ctx.profile };
}

export async function listManagedDecks(ctx: V1AdapterContext): Promise<ManagedDeck[]> {
  const method = "decks.list";
  const decks = await ctx.request(method, {}, z.array(managedDeckSchema));
  if (new Set(decks.map(({ id }) => id)).size !== decks.length ||
      new Set(decks.map(({ name }) => deckNameKey(name))).size !== decks.length ||
      decks.some(({ kind, presetId }) => (kind === "normal") !== (presetId !== null))) {
    throw invalidAnkiV1Response(method);
  }
  return decks;
}

export async function renameManagedDeck(ctx: DeckManagementContext, id: number, name: string): Promise<ManagedDeck> {
  const method = "decks.update";
  const deck = await ctx.request(method, { deck: { id: String(id) }, name }, managedDeckSchema);
  if (deck.id !== id || deck.name !== name) throw invalidAnkiV1Response(method);
  return deck;
}

export function deckNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
