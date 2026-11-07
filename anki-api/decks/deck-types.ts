export type DeckId = number;
export type CardId = number;
export type DeckNameMap = Record<string, DeckId>;
export type CardsByDeckName = Record<string, CardId[]>;

export interface AnkiDeckStats {
  deck_id: DeckId;
  name: string;
  new_count: number;
  learn_count: number;
  review_count: number;
  total_in_deck?: number;
}

export type AnkiDeckStatsMap = Record<string, AnkiDeckStats>;
