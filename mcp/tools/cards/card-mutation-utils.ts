import type { AnkiCardInfo } from "../../../anki-api/cards/card-types.js";
import { loadCardInfo } from "./card-loader.js";

/** Rejects an incomplete selection before any write; never edits a subset. */
export async function loadCardMutationScope(cardIds: number[]): Promise<AnkiCardInfo[]> {
  const { cards, missingCardIds } = await loadCardInfo(cardIds);
  if (missingCardIds.length > 0) {
    throw new Error(
      `No Cards were changed. Requested Cards are missing or incomplete: ${missingCardIds.join(", ")}. No partial selection will be applied.`,
    );
  }
  return cards;
}

interface CardWrite {
  cardIds: number[];
  apply: () => Promise<unknown>;
}

/**
 * Sends each planned write once, then verifies the selected Cards' identities
 * and operation-specific postconditions. Acknowledgement is not verification.
 * These reads/writes are not atomic and provide no rollback or retry.
 */
export async function applyAndVerifyCardMutation(
  operation: string,
  before: AnkiCardInfo[],
  writes: CardWrite[],
  matches: (after: AnkiCardInfo, before: AnkiCardInfo) => boolean,
  verifyExtra?: (after: AnkiCardInfo[]) => Promise<void>,
): Promise<AnkiCardInfo[]> {
  const acknowledgedCardIds: number[] = [];
  for (const [index, write] of writes.entries()) {
    try {
      await write.apply();
      acknowledgedCardIds.push(...write.cardIds);
    } catch (error) {
      const notAttempted = writes.slice(index + 1).flatMap(({ cardIds }) => cardIds);
      throw new Error(
        `Could not confirm ${operation} for Card IDs: ${write.cardIds.join(", ")}. Earlier writes acknowledged but not verified: ${acknowledgedCardIds.join(", ") || "none"}. Not attempted: ${notAttempted.join(", ") || "none"}. Some changes may already have reached Anki. No automatic retry or rollback was performed; inspect Anki before retrying. ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  try {
    const { cards, missingCardIds } = await loadCardInfo(before.map(({ cardId }) => cardId));
    if (missingCardIds.length > 0) {
      throw new Error(`Cards missing or incomplete during verification: ${missingCardIds.join(", ")}`);
    }
    const beforeById = new Map(before.map((card) => [card.cardId, card]));
    const mismatched = cards.filter((after) => {
      const original = beforeById.get(after.cardId);
      return original === undefined || after.note !== original.note ||
        after.modelName !== original.modelName || after.ord !== original.ord ||
        !matches(after, original);
    });
    if (mismatched.length > 0) {
      throw new Error(`Unexpected Card state for IDs: ${mismatched.map(({ cardId }) => cardId).join(", ")}`);
    }
    await verifyExtra?.(cards);
    return cards;
  } catch (error) {
    throw new Error(
      `Anki acknowledged ${operation} for Card IDs: ${acknowledgedCardIds.join(", ")}, but verification failed. Changes may already be applied. No automatic retry or rollback was performed; inspect Anki before retrying. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Card operation failure";
}
