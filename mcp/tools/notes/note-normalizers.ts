import type {
  AnkiNoteFields,
  AnkiNoteInfo,
} from "../../../anki-api/notes/note-types.js";
import type { V1Note } from "../../../anki-api/v1/anki-v1-note-client.js";
import type {
  NoteDetails,
  NoteSummary,
} from "./shared-schemas.js";
import { calculateNoteFieldHash } from "./note-field-utils.js";

const FIELD_PREVIEW_LENGTH = 200;

/** Converts an Anki note payload into a compact search result. */
export function toNoteSummary(note: AnkiNoteInfo): NoteSummary {
  return {
    noteId: note.noteId,
    modelName: note.modelName,
    tags: [...note.tags],
    fieldPreviews: toNoteFieldPreviews(
      Object.entries(sortFields(note.fields)).map(([name, field]) => [name, field.value]),
    ),
    cardIds: [...note.cards],
    modifiedAt: new Date(note.mod * 1_000).toISOString(),
  };
}

/** Uses the same compact field previews for v1 search and diagnostics. */
export function toV1NoteSummary(note: V1Note): NoteSummary {
  return {
    noteId: note.id,
    modelName: note.noteType.name,
    tags: note.tags,
    fieldPreviews: toNoteFieldPreviews(Object.entries(note.fields)),
    cardIds: note.cardIds,
    modifiedAt: new Date(note.modifiedAt).toISOString(),
  };
}

/** Converts an Anki note payload into a complete LLM-facing representation. */
export function toNoteDetails(note: AnkiNoteInfo): NoteDetails {
  return {
    noteId: note.noteId,
    modelName: note.modelName,
    tags: [...note.tags],
    fields: Object.fromEntries(
      Object.entries(sortFields(note.fields)).map(([name, field]) => [
        name,
        { ...field, hash: calculateNoteFieldHash(field.value) },
      ]),
    ),
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

export function toNoteFieldPreviews(fields: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(fields.map(([name, value]) => [name, createFieldPreview(value)]));
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
