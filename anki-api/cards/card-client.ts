import { invokeAnki } from "../anki-request.js";
import type {
  AnkiCardInfoResult,
  AnkiCardReviewMap,
  AnkiCardSuspensionStatus,
  AnkiSetCardValueResult,
  CardId,
} from "./card-types.js";
import type { NoteId } from "../notes/note-types.js";

/** Finds card IDs with Anki's native search syntax. */
export function findAnkiCards(query: string): Promise<CardId[]> {
  return invokeAnki<CardId[]>("findCards", { query });
}

/** Resolves the distinct note IDs that own the requested cards. */
export function getAnkiNoteIdsForCards(
  cardIds: CardId[],
): Promise<NoteId[]> {
  if (cardIds.length === 0) {
    return Promise.resolve([]);
  }

  return invokeAnki<NoteId[]>("cardsToNotes", { cards: cardIds });
}

/** Gets Anki's complete card payload for the requested IDs. */
export function getAnkiCardsInfo(
  cardIds: CardId[],
): Promise<AnkiCardInfoResult[]> {
  return invokeAnki<AnkiCardInfoResult[]>("cardsInfo", { cards: cardIds });
}

/** Checks whether the requested existing cards are currently due. */
export function getAnkiCardsDueStatus(
  cardIds: CardId[],
): Promise<boolean[]> {
  return invokeAnki<boolean[]>("areDue", { cards: cardIds });
}

/** Checks whether the requested cards are suspended. */
export function getAnkiCardsSuspensionStatus(
  cardIds: CardId[],
): Promise<AnkiCardSuspensionStatus[]> {
  return invokeAnki<AnkiCardSuspensionStatus[]>("areSuspended", {
    cards: cardIds,
  });
}

/** Suspends or unsuspends a batch of cards. */
export async function setAnkiCardsSuspended(
  cardIds: CardId[],
  suspended: boolean,
): Promise<void> {
  await invokeAnki<boolean>(suspended ? "suspend" : "unsuspend", {
    cards: cardIds,
  });
}

/** Sets only the supported Anki flag field on one card. */
export async function setAnkiCardFlag(
  cardId: CardId,
  flag: number,
): Promise<void> {
  const result = await invokeAnki<AnkiSetCardValueResult>(
    "setSpecificValueOfCard",
    {
      card: cardId,
      keys: ["flags"],
      newValues: [flag],
    },
  );

  if (
    result === false ||
    result.length !== 1 ||
    result[0] !== true
  ) {
    throw new Error(`AnkiConnect could not set the flag for card ${cardId}`);
  }
}

/** Reschedules cards with Anki's Set Due Date syntax. */
export async function rescheduleAnkiCards(
  cardIds: CardId[],
  due: string,
): Promise<void> {
  await invokeAnki<boolean>("setDueDate", {
    cards: cardIds,
    days: due,
  });
}

/** Resets cards to the new state. */
export async function resetAnkiCardsToNew(
  cardIds: CardId[],
): Promise<void> {
  await invokeAnki<null>("forgetCards", { cards: cardIds });
}

/** Forces cards into Anki's relearning state. */
export async function startAnkiCardsRelearning(
  cardIds: CardId[],
): Promise<void> {
  await invokeAnki<null>("relearnCards", { cards: cardIds });
}

/** Gets the complete review log for each requested card. */
export function getAnkiCardReviews(
  cardIds: CardId[],
): Promise<AnkiCardReviewMap> {
  return invokeAnki<AnkiCardReviewMap>("getReviewsOfCards", {
    cards: cardIds,
  });
}
