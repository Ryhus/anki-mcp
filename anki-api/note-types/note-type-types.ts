export type NoteTypeId = number;

export type AnkiNoteTypeNameMap = Record<string, NoteTypeId>;

export type AnkiTemplateFieldUsage = [string[], string[]];

export type AnkiNoteTypeTemplateMap = Record<
  string,
  AnkiTemplateFieldUsage
>;
