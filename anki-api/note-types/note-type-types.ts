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
