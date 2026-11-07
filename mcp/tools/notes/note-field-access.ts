import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { updateAnkiNoteFields } from "../../../anki-api/notes/note-client.js";
import type { AnkiNoteFieldUpdate, NoteId } from "../../../anki-api/notes/note-types.js";
import { getV1CollectionSession } from "../../../anki-api/v1/anki-v1-collection-client.js";
import { getV1Notes, updateV1NoteFields } from "../../../anki-api/v1/anki-v1-note-client.js";
import { loadNotes } from "./note-loader.js";

export interface NoteFieldSnapshot {
  noteId: NoteId;
  fields: Record<string, { value: string }>;
}

export interface NoteFieldAccess {
  read(noteIds: NoteId[]): Promise<{ notes: NoteFieldSnapshot[]; missingNoteIds: NoteId[] }>;
  write(patch: AnkiNoteFieldUpdate): Promise<void>;
}

/** Selects one backend and binds every v1 step in this tool call to one session. */
export async function openNoteFieldAccess(): Promise<NoteFieldAccess> {
  if (!useAnkiV1("notes.update")) return { read: loadNotes, write: updateAnkiNoteFields };

  const session = await getV1CollectionSession();
  return {
    async read(noteIds) {
      const { notes, missingNoteIds } = await getV1Notes(noteIds, session);
      return {
        notes: notes.map(({ id, fields }) => ({
          noteId: id,
          fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value }])),
        })),
        missingNoteIds,
      };
    },
    write(patch) {
      return updateV1NoteFields(patch, session);
    },
  };
}
