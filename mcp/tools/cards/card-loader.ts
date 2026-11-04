import {
  getAnkiCardsDueStatus,
  getAnkiCardsInfo,
  getAnkiCardsSuspensionStatus,
} from "../../../anki-api/cards/card-client.js";
import type {
  AnkiCardInfo,
  AnkiCardInfoResult,
  CardId,
} from "../../../anki-api/cards/card-types.js";
import { unique } from "./card-utils.js";

export interface LoadedCard {
  info: AnkiCardInfo;
  isDue: boolean;
  isSuspended: boolean;
}

export interface LoadedCards {
  cards: LoadedCard[];
  missingCardIds: CardId[];
}

export interface LoadedCardInfo {
  cards: AnkiCardInfo[];
  missingCardIds: CardId[];
}

/**
 * Loads and enriches existing cards while reporting IDs that AnkiConnect
 * represents as empty card-info objects.
 */
export async function loadCards(cardIds: CardId[]): Promise<LoadedCards> {
  const { cards: cardInfo, missingCardIds } = await loadCardInfo(cardIds);
  const existingCardIds = cardInfo.map(({ cardId }) => cardId);

  if (existingCardIds.length === 0) {
    return { cards: [], missingCardIds };
  }

  const dueStatuses = await getAnkiCardsDueStatus(existingCardIds);
  const suspensionStatuses =
    await getAnkiCardsSuspensionStatus(existingCardIds);

  if (
    dueStatuses.length !== existingCardIds.length ||
    suspensionStatuses.length !== existingCardIds.length
  ) {
    throw new Error("AnkiConnect returned misaligned card status results");
  }

  const cards = cardInfo.map((info, index) => {
    const isDue = dueStatuses[index];
    const isSuspended = suspensionStatuses[index];

    if (
      typeof isDue !== "boolean" ||
      typeof isSuspended !== "boolean"
    ) {
      throw new Error(
        `AnkiConnect returned incomplete data for card ${info.cardId}`,
      );
    }

    return { info, isDue, isSuspended };
  });

  return { cards, missingCardIds };
}

/** Loads existing card payloads without requesting additional scheduler data. */
export async function loadCardInfo(
  cardIds: CardId[],
): Promise<LoadedCardInfo> {
  const requestedCardIds = unique(cardIds);
  const rawCards = await getAnkiCardsInfo(requestedCardIds);
  if (!Array.isArray(rawCards)) {
    throw new Error("AnkiConnect returned an invalid cardsInfo result");
  }
  const requested = new Set(requestedCardIds);
  const cardsById = new Map<CardId, AnkiCardInfo>();

  for (const rawCard of rawCards) {
    if (isAnkiCardInfo(rawCard)) {
      if (!requested.has(rawCard.cardId) || cardsById.has(rawCard.cardId)) {
        throw new Error("AnkiConnect returned unexpected or duplicate Card IDs");
      }
      cardsById.set(rawCard.cardId, rawCard);
    }
  }

  const existingCardIds = requestedCardIds.filter((cardId) =>
    cardsById.has(cardId),
  );
  const missingCardIds = requestedCardIds.filter(
    (cardId) => !cardsById.has(cardId),
  );
  const cards = existingCardIds.map((cardId) => {
    const info = cardsById.get(cardId);

    if (info === undefined) {
      throw new Error(`AnkiConnect omitted card ${cardId}`);
    }

    return info;
  });

  return { cards, missingCardIds };
}

function isAnkiCardInfo(card: AnkiCardInfoResult | null): card is AnkiCardInfo {
  return (
    typeof card === "object" && card !== null && !Array.isArray(card) &&
    typeof card.cardId === "number" &&
    typeof card.note === "number" &&
    typeof card.deckName === "string" &&
    typeof card.modelName === "string" &&
    typeof card.ord === "number" &&
    typeof card.type === "number" &&
    typeof card.queue === "number" &&
    typeof card.interval === "number" &&
    typeof card.factor === "number" &&
    typeof card.reps === "number" &&
    typeof card.lapses === "number" &&
    Number.isSafeInteger(card.due) &&
    Number.isSafeInteger(card.left) &&
    typeof card.mod === "number" &&
    typeof card.question === "string" &&
    typeof card.answer === "string" &&
    typeof card.fields === "object" &&
    card.fields !== null
  );
}
