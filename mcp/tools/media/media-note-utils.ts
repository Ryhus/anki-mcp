import type { AnkiNoteInfo } from "../../../anki-api/notes/note-types.js";

/** Resolves user-submitted field casing against one concrete Anki note. */
export function resolveNoteFieldName(
  note: AnkiNoteInfo,
  submittedFieldName: string,
): string | null {
  const submittedLowercase = submittedFieldName.toLowerCase();

  return (
    Object.keys(note.fields).find(
      (fieldName) => fieldName.toLowerCase() === submittedLowercase,
    ) ?? null
  );
}
