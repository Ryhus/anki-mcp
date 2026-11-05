import { invokeAnki } from "../anki-request.js";
import { useAnkiV1 } from "../anki-api-mode.js";
import { openV1Adapter, searchV1IdPage } from "../v1/anki-v1-adapter-utils.js";
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

/** Reads a single native v1 page, without fetching the entire Card ID set. */
export async function findAnkiCardPage(query: string, limit: number, cursor?: string) {
  return searchV1IdPage(await openV1Adapter({}), "cards.search", query, limit, cursor);
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
  render = true,
): Promise<AnkiCardInfoResult[]> {
  return invokeAnki<AnkiCardInfoResult[]>("cardsInfo", {
    cards: cardIds, ...(useAnkiV1("cardsInfo") ? { render } : {}),
  });
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
): Promise<boolean | null> {
  const result = await invokeAnki<unknown>(suspended ? "suspend" : "unsuspend", {
    cards: cardIds,
  });
  // A false suspend result can mean the desired state was already reached. Legacy
  // unsuspend returns null, not a success boolean; both need state readback.
  if (typeof result !== "boolean" && !(result === null && !suspended)) {
    throw new Error("AnkiConnect returned an invalid suspension acknowledgement");
  }
  return result;
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
    !Array.isArray(result) ||
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
  const result = await invokeAnki<unknown>("setDueDate", {
    cards: cardIds,
    days: due,
  });
  if (result !== true) {
    throw new Error("AnkiConnect did not acknowledge setting card due dates");
  }
}

/** Resets cards to the new state. */
export async function resetAnkiCardsToNew(
  cardIds: CardId[],
): Promise<void> {
  const result = await invokeAnki<unknown>("forgetCards", { cards: cardIds });
  if (result !== null) {
    throw new Error("AnkiConnect returned an invalid reset acknowledgement");
  }
}

/** Starts native relearning; current AnkiConnect may record an Again answer. */
export async function startAnkiCardsRelearning(
  cardIds: CardId[],
): Promise<void> {
  const result = await invokeAnki<unknown>("relearnCards", { cards: cardIds });
  if (result !== null) {
    throw new Error("AnkiConnect returned an invalid relearning acknowledgement");
  }
}

/** Gets the complete review log for each requested card. */
export function getAnkiCardReviews(
  cardIds: CardId[],
): Promise<AnkiCardReviewMap> {
  return invokeAnki<AnkiCardReviewMap>("getReviewsOfCards", {
    cards: cardIds,
  });
}
