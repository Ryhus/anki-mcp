import { z } from "zod";
import type { AnkiDeckStatsMap } from "../decks/deck-types.js";
import { getV1NameMap, v1EntityIdSchema, v1EntitySummarySchema } from "./anki-v1-collection-client.js";
import { getV1Cards } from "./anki-v1-cards-adapter.js";
import { readV1Acks, ref, stringIds, type V1AdapterContext, type V1Route } from "./anki-v1-adapter-utils.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";

const deckSchema = v1EntitySummarySchema.extend({ kind: z.enum(["normal", "filtered"]) });
const countsSchema = z.object({
  deckId: v1EntityIdSchema, new: z.number().int().nonnegative(), learning: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
});

function createDeck(ctx: V1AdapterContext, name: unknown) {
  return ctx.request("decks.create", { name }, deckSchema);
}

export const v1DeckRoutes = {
  deckNamesAndIds: (_params, ctx) => getV1NameMap("decks.list", ctx.session, ctx.options),
  async createDeck({ deck }, ctx) {
    return (await createDeck(ctx, deck)).id;
  },
  async getDeckStats({ decks }, ctx) {
    const stats: AnkiDeckStatsMap = {};
    for (const name of decks as string[]) {
      const counts = await ctx.request("decks.getCounts", { deck: ref(name), includeChildren: true }, countsSchema);
      if (Object.hasOwn(stats, counts.deckId)) throw invalidAnkiV1Response("decks.getCounts");
      stats[String(counts.deckId)] = {
        deck_id: counts.deckId, name, new_count: counts.new, learn_count: counts.learning,
        review_count: counts.review, total_in_deck: counts.total,
      };
    }
    return stats;
  },
  async getDeckConfig({ deck }, ctx) {
    const found = await ctx.request("decks.get", { deck: ref(deck as string) }, deckSchema);
    if (found.name !== deck) throw invalidAnkiV1Response("decks.get");
    return { dyn: found.kind === "filtered" };
  },
  async getDecks({ cards }, ctx) {
    const groups = new Map<string, number[]>();
    for (const card of await getV1Cards(ctx, cards as number[], false)) {
      if (card === null) throw invalidAnkiV1Response("cards.getMany");
      const ids = groups.get(card.deck.name) ?? [];
      ids.push(card.id);
      groups.set(card.deck.name, ids);
    }
    return Object.fromEntries(groups);
  },
  async changeDeck({ cards, deck }, ctx) {
    const target = await createDeck(ctx, deck);
    if (target.kind !== "normal") throw new Error("A filtered deck cannot be a move destination.");
    const ids = stringIds(cards as number[]);
    await readV1Acks(ctx, "cards.move", { ids, deck: { id: String(target.id) } }, ids.length);
    return null;
  },
  async deleteDecks({ decks, cardsToo }, ctx) {
    if (cardsToo !== true) throw new Error("Deck deletion requires confirmed Card deletion.");
    const targets = (decks as string[]).map(ref);
    const method = "decks.delete";
    if (!(await readV1Acks(ctx, method, { decks: targets, deleteCards: true }, targets.length)).every(Boolean)) {
      throw invalidAnkiV1Response(method);
    }
    return null;
  },
} satisfies Record<string, V1Route>;
