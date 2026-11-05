import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { getDeckNameMap } from "../../../anki-api/decks/deck-client.js";
import { getAnkiNoteTypeFieldNames, getAnkiNoteTypeNameMap } from "../../../anki-api/note-types/note-type-client.js";
import { createAnkiNotes, getAnkiNotesInfo, validateAnkiNoteDrafts } from "../../../anki-api/notes/note-client.js";
import type { AnkiNoteDraft, AnkiNoteDraftValidation } from "../../../anki-api/notes/note-types.js";
import {
  getV1CollectionSession,
  getV1NameMap,
  getV1NoteTypeDesign,
} from "../../../anki-api/v1/anki-v1-collection-client.js";
import { retrieveV1MediaFile } from "../../../anki-api/v1/anki-v1-media-client.js";
import { getV1Notes } from "../../../anki-api/v1/anki-v1-note-client.js";
import { createV1Notes, validateV1NoteDrafts } from "../../../anki-api/v1/anki-v1-note-creation-client.js";
import { loadAnkiMediaFiles, type LoadedMediaFile } from "../media/media-loader.js";

export interface NoteCreationAccess {
  mode: "legacy" | "v1";
  getDecks(): Promise<Record<string, number>>;
  getNoteTypes(): Promise<Record<string, number>>;
  getFields(name: string): Promise<string[]>;
  loadMediaFiles(names: string[]): Promise<Map<string, LoadedMediaFile | null>>;
  validate(notes: AnkiNoteDraft[]): Promise<AnkiNoteDraftValidation[]>;
  create(notes: AnkiNoteDraft[]): Promise<unknown>;
  readback(ids: number[]): Promise<unknown>;
}

const legacyCreationAccess: NoteCreationAccess = {
  mode: "legacy",
  getDecks: getDeckNameMap,
  getNoteTypes: getAnkiNoteTypeNameMap,
  getFields: getAnkiNoteTypeFieldNames,
  loadMediaFiles: loadAnkiMediaFiles,
  validate: validateAnkiNoteDrafts,
  create: createAnkiNotes,
  readback: getAnkiNotesInfo,
};

/** Uses one backend and, in v1, one collection session for the entire workflow. */
export async function openNoteCreationAccess(): Promise<NoteCreationAccess> {
  if (!useAnkiV1("notes.validateMany")) return legacyCreationAccess;
  const session = await getV1CollectionSession();
  return {
    mode: "v1",
    getDecks: () => getV1NameMap("decks.list", session),
    getNoteTypes: () => getV1NameMap("noteTypes.list", session),
    getFields: async (name) => (await getV1NoteTypeDesign(name, session)).fields.map(({ name }) => name),
    loadMediaFiles: (names) => loadAnkiMediaFiles(names, (name) => retrieveV1MediaFile(name, session)),
    validate: (notes) => validateV1NoteDrafts(notes, session),
    create: (notes) => createV1Notes(notes, session),
    async readback(ids) {
      const { notes } = await getV1Notes(ids, session);
      return notes.map(({ id, noteType, cardIds }) => ({ noteId: id, modelName: noteType.name, cards: cardIds }));
    },
  };
}
