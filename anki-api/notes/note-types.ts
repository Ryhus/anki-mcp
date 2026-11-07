export type NoteId = number;
export type CardId = number;

export interface AnkiNoteField {
  value: string;
  order: number;
}

export type AnkiNoteFields = Record<string, AnkiNoteField>;

export interface AnkiNoteInfo {
  noteId: NoteId;
  profile?: string;
  modelName: string;
  tags: string[];
  fields: AnkiNoteFields;
  mod: number;
  cards: CardId[];
}

export type AnkiNoteInfoResult = Partial<AnkiNoteInfo>;

export interface AnkiDuplicateScopeOptions {
  deckName?: string;
  checkChildren: boolean;
  checkAllModels: boolean;
}

export interface AnkiNoteOptions {
  allowDuplicate: boolean;
  duplicateScope: "collection" | "deck";
  duplicateScopeOptions: AnkiDuplicateScopeOptions;
}

export interface AnkiNoteDraft {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options: AnkiNoteOptions;
}

export interface AnkiNoteDraftValidation {
  canAdd: boolean;
  error?: string;
}

export interface AnkiNoteFieldUpdate {
  id: NoteId;
  fields: Record<string, string>;
}
