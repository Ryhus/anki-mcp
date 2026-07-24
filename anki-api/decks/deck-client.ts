import { invokeAnki } from "../anki-request.js";
import type {
  AnkiDeckStatsMap,
  CardId,
  CardsByDeckName,
  DeckId,
  DeckNameMap,
} from "./deck-types.js";

export function getDeckNameMap(): Promise<DeckNameMap> {
  return invokeAnki<DeckNameMap>("deckNamesAndIds");
}

export function createAnkiDeck(name: string): Promise<DeckId> {
  return invokeAnki<DeckId>("createDeck", { deck: name });
}

export function getAnkiDeckStats(
  names: string[],
): Promise<AnkiDeckStatsMap> {
  return invokeAnki<AnkiDeckStatsMap>("getDeckStats", { decks: names });
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
 * Permanently deletes a deck and all cards it contains.
 */
export async function deleteAnkiDeck(name: string): Promise<void> {
  await invokeAnki<null>("deleteDecks", {
    decks: [name],
    cardsToo: true,
  });
}
