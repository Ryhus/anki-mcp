export type NoteTypeId = number;

export type AnkiNoteTypeNameMap = Record<string, NoteTypeId>;

export type AnkiTemplateFieldUsage = [string[], string[]];

export type AnkiNoteTypeTemplateMap = Record<
  string,
  AnkiTemplateFieldUsage
>;

export interface AnkiNoteTypeTemplate {
  Front: string;
  Back: string;
}

export type AnkiNoteTypeTemplates = Record<
  string,
  AnkiNoteTypeTemplate
>;

export interface AnkiNoteTypeTemplateUpdate {
  Front?: string;
  Back?: string;
}

export type AnkiNoteTypeTemplateUpdates = Record<
  string,
  AnkiNoteTypeTemplateUpdate
>;

export interface AnkiNoteTypeStyling {
  css: string;
}

export interface AnkiCreateNoteTypeTemplate {
  Name: string;
  Front: string;
  Back: string;
}

export interface AnkiCreateNoteTypeInput {
  modelName: string;
  inOrderFields: string[];
  cardTemplates: AnkiCreateNoteTypeTemplate[];
  css: string;
  isCloze: boolean;
  sortField?: string;
}

export interface AnkiCreatedNoteType {
  id: number;
  name: string;
}
