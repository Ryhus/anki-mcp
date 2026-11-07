export type CardId = number;

export interface AnkiCardField {
  value: string;
  order: number;
}

export type AnkiCardFields = Record<string, AnkiCardField>;

export interface AnkiCardInfo {
  cardId: CardId;
  fields: AnkiCardFields;
  fieldOrder: number;
  question: string;
  answer: string;
  modelName: string;
  ord: number;
  deckName: string;
  css: string;
  factor: number;
  interval: number;
  note: number;
  type: number;
  queue: number;
  due: number;
  reps: number;
  lapses: number;
  left: number;
  mod: number;
  flags?: number;
  nextReviews?: unknown;
}

export type AnkiCardInfoResult = Partial<AnkiCardInfo>;
export type AnkiCardSuspensionStatus = boolean | null;

export interface AnkiCardReview {
  id: number;
  usn: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

export type AnkiCardReviewMap = Record<string, AnkiCardReview[]>;

export type AnkiSetCardValueResult =
  | false
  | Array<true | [false, string]>;
