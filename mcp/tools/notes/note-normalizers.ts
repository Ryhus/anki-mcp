import type {
  AnkiNoteFields,
  AnkiNoteInfo,
} from "../../../anki-api/notes/note-types.js";
import type {
  NoteDetails,
  NoteSummary,
} from "./shared-schemas.js";

const FIELD_PREVIEW_LENGTH = 200;

/** Converts an Anki note payload into a compact search result. */
export function toNoteSummary(note: AnkiNoteInfo): NoteSummary {
  return {
    noteId: note.noteId,
    modelName: note.modelName,
    tags: [...note.tags],
    fieldPreviews: Object.fromEntries(
      Object.entries(sortFields(note.fields)).map(([name, field]) => [
        name,
        createFieldPreview(field.value),
      ]),
    ),
    cardIds: [...note.cards],
    modifiedAt: new Date(note.mod * 1_000).toISOString(),
  };
}

/** Converts an Anki note payload into a complete LLM-facing representation. */
export function toNoteDetails(note: AnkiNoteInfo): NoteDetails {
  return {
    noteId: note.noteId,
    modelName: note.modelName,
    tags: [...note.tags],
    fields: sortFields(note.fields),
    cardIds: [...note.cards],
    modifiedAt: new Date(note.mod * 1_000).toISOString(),
  };
}

function sortFields(fields: AnkiNoteFields): AnkiNoteFields {
  return Object.fromEntries(
    Object.entries(fields).sort(
      ([, left], [, right]) => left.order - right.order,
    ),
  );
}

function createFieldPreview(value: string): string {
  const plainText = value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:div|p|li)>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();

  if (plainText.length <= FIELD_PREVIEW_LENGTH) {
    return plainText;
  }

  return `${plainText.slice(0, FIELD_PREVIEW_LENGTH - 1)}…`;
}
