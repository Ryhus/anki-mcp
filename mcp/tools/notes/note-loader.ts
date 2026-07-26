import { getAnkiNotesInfo } from "../../../anki-api/notes/note-client.js";
import type {
  AnkiNoteInfo,
  AnkiNoteInfoResult,
  NoteId,
} from "../../../anki-api/notes/note-types.js";
import { unique } from "./note-utils.js";

export interface LoadedNotes {
  notes: AnkiNoteInfo[];
  missingNoteIds: NoteId[];
}

/**
 * Loads notes in requested order while converting AnkiConnect's empty objects
 * for unknown IDs into an explicit missing-ID list.
 */
export async function loadNotes(noteIds: NoteId[]): Promise<LoadedNotes> {
  const requestedNoteIds = unique(noteIds);
  const rawNotes = await getAnkiNotesInfo(requestedNoteIds);
  const notesById = new Map<NoteId, AnkiNoteInfo>();

  for (const rawNote of rawNotes) {
    if (isAnkiNoteInfo(rawNote)) {
      notesById.set(rawNote.noteId, rawNote);
    }
  }

  const missingNoteIds = requestedNoteIds.filter(
    (noteId) => !notesById.has(noteId),
  );
  const notes = requestedNoteIds.flatMap((noteId) => {
    const note = notesById.get(noteId);
    return note === undefined ? [] : [note];
  });

  return { notes, missingNoteIds };
}

function isAnkiNoteInfo(note: AnkiNoteInfoResult): note is AnkiNoteInfo {
  return (
    typeof note.noteId === "number" &&
    (note.profile === undefined || typeof note.profile === "string") &&
    typeof note.modelName === "string" &&
    Array.isArray(note.tags) &&
    note.tags.every((tag) => typeof tag === "string") &&
    isAnkiNoteFields(note.fields) &&
    typeof note.mod === "number" &&
    Array.isArray(note.cards) &&
    note.cards.every((cardId) => typeof cardId === "number")
  );
}

function isAnkiNoteFields(
  fields: AnkiNoteInfoResult["fields"],
): fields is AnkiNoteInfo["fields"] {
  if (typeof fields !== "object" || fields === null) {
    return false;
  }

  return Object.values(fields).every(
    (field) =>
      typeof field === "object" &&
      field !== null &&
      typeof field.value === "string" &&
      typeof field.order === "number",
  );
}
