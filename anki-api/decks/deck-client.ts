import { invokeAnki } from "../anki-request.js";
import { useAnkiV1 } from "../anki-api-mode.js";
import { getV1NameMap } from "../v1/anki-v1-collection-client.js";
import { findAnkiCards } from "../cards/card-client.js";
import type {
  AnkiDeckStatsMap,
  CardId,
  CardsByDeckName,
  DeckId,
  DeckNameMap,
} from "./deck-types.js";

export async function getDeckNameMap(): Promise<DeckNameMap> {
  if (useAnkiV1("decks.list")) return getV1NameMap("decks.list");
  return invokeAnki<DeckNameMap>("deckNamesAndIds");
}

export function createAnkiDeck(name: string): Promise<DeckId> {
  return invokeAnki<DeckId>("createDeck", { deck: name });
}

export async function getAnkiDeckStats(
  names: string[],
): Promise<AnkiDeckStatsMap> {
  try {
    return await invokeAnki<AnkiDeckStatsMap>("getDeckStats", { decks: names });
  } catch (error) {
    if (!areDeckCountsUnavailable(error)) {
      throw error;
    }
  }

  // Newer Anki versions omit the empty default deck from the scheduler tree.
  // AnkiConnect can fail the entire batch instead of returning its zero counts.
  const knownDecks = await getDeckNameMap();
  const result: AnkiDeckStatsMap = {};
  // Keep the fallback sequential: AnkiConnect limits simultaneous HTTP clients.
  for (const name of names) {
    try {
      Object.assign(result, await invokeAnki<AnkiDeckStatsMap>("getDeckStats", { decks: [name] }));
    } catch (error) {
      const id = knownDecks[name];
      if (!areDeckCountsUnavailable(error) || id === undefined) {
        throw error;
      }

      // Native deck search includes descendants. Never infer zero scheduler
      // counts for a deck that contains cards, even if AnkiConnect fails.
      const literalName = name.replace(/[\\_*"]/gu, (character) => `\\${character}`);
      const cards = await findAnkiCards(`deck:"${literalName}"`);
      if (cards.length > 0) {
        throw error;
      }

      result[String(id)] = {
        deck_id: id, name, new_count: 0, learn_count: 0,
        review_count: 0, total_in_deck: 0,
      };
    }
  }

  return result;
}

function areDeckCountsUnavailable(error: unknown): boolean {
  return error instanceof Error &&
    error.message === 'AnkiConnect action "getDeckStats" failed: Deck counts unavailable.';
}

export function getCardsByDeck(cardIds: CardId[]): Promise<CardsByDeckName> {
  return invokeAnki<CardsByDeckName>("getDecks", { cards: cardIds });
}

export async function moveAnkiCards(
  cardIds: CardId[],
  targetDeck: string,
): Promise<void> {
  await invokeAnki<null>("changeDeck", {
    cards: cardIds,
    deck: targetDeck,
  });
}

/**
 * Requests native removal of a deck and its descendants. Callers must review
 * normal/filtered semantics and Default's special handling before using this.
 */
export async function deleteAnkiDeck(name: string): Promise<void> {
  await invokeAnki<null>("deleteDecks", {
    decks: [name],
    cardsToo: true,
  });
}
