import type { AnkiCardFields } from "../../../anki-api/cards/card-types.js";
import type { LoadedCard } from "./card-loader.js";
import type {
  CardDetails,
  CardFlag,
  CardFlagOutput,
  CardInterval,
  CardState,
  CardSummary,
} from "./shared-schemas.js";

const FLAG_VALUES = {
  none: 0,
  red: 1,
  orange: 2,
  green: 3,
  blue: 4,
  pink: 5,
  turquoise: 6,
  purple: 7,
} as const satisfies Record<CardFlag, number>;

/** Converts Anki's scheduler-oriented card payload into an LLM-facing summary. */
export function toCardSummary(card: LoadedCard): CardSummary {
  const { info, isDue, isSuspended } = card;

  return {
    cardId: info.cardId,
    noteId: info.note,
    deckName: info.deckName,
    modelName: info.modelName,
    templateOrdinal: info.ord,
    state: toCardState(info.type, info.queue),
    isDue,
    isSuspended,
    interval: toCardInterval(info.interval),
    easePercent: info.factor === 0 ? null : info.factor / 10,
    repetitions: info.reps,
    lapses: info.lapses,
    flag: toCardFlag(info.flags),
  };
}

/** Adds note fields and optional rendered card HTML to a card summary. */
export function toCardDetails(
  card: LoadedCard,
  includeRenderedContent: boolean,
): CardDetails {
  return {
    ...toCardSummary(card),
    fields: sortFields(card.info.fields),
    modifiedAt: new Date(card.info.mod * 1_000).toISOString(),
    ...(includeRenderedContent
      ? {
          rendered: {
            question: card.info.question,
            answer: card.info.answer,
          },
        }
      : {}),
  };
}

export function toCardInterval(interval: number): CardInterval {
  return {
    value: Math.abs(interval),
    unit: interval < 0 ? "seconds" : "days",
  };
}

export function toCardFlagValue(flag: CardFlag): number {
  return FLAG_VALUES[flag];
}

export function toCardFlag(flag: number | undefined): CardFlagOutput {
  const entry = Object.entries(FLAG_VALUES).find(([, value]) => value === flag);

  return (entry?.[0] as CardFlag | undefined) ?? "unknown";
}

export function toCardState(type: number, queue: number): CardState {
  if (queue === -1) {
    return "suspended";
  }

  if (queue === -2 || queue === -3) {
    return "buried";
  }

  if (queue === 4) {
    return "preview";
  }

  switch (type) {
    case 0:
      return "new";
    case 1:
      return "learning";
    case 2:
      return "review";
    case 3:
      return "relearning";
    default:
      return "unknown";
  }
}

function sortFields(fields: AnkiCardFields): AnkiCardFields {
  return Object.fromEntries(
    Object.entries(fields).sort(
      ([, left], [, right]) => left.order - right.order,
    ),
  );
}
