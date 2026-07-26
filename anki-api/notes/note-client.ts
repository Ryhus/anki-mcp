import { invokeAnki } from "../anki-request.js";
import type {
  AnkiNoteDraft,
  AnkiNoteDraftValidation,
  AnkiNoteFieldUpdate,
  AnkiNoteInfoResult,
  NoteId,
} from "./note-types.js";

/** Finds note IDs with Anki's native search syntax. */
export function findAnkiNotes(query: string): Promise<NoteId[]> {
  return invokeAnki<NoteId[]>("findNotes", { query });
}

/** Gets complete note payloads for the requested IDs. */
export function getAnkiNotesInfo(
  noteIds: NoteId[],
): Promise<AnkiNoteInfoResult[]> {
  return invokeAnki<AnkiNoteInfoResult[]>("notesInfo", {
    notes: noteIds,
  });
}

/** Validates candidate notes with Anki's own creation and duplicate rules. */
export function validateAnkiNoteDrafts(
  notes: AnkiNoteDraft[],
): Promise<AnkiNoteDraftValidation[]> {
  return invokeAnki<AnkiNoteDraftValidation[]>(
    "canAddNotesWithErrorDetail",
    { notes },
  );
}

/** Creates a batch of notes and returns one ID per candidate. */
export function createAnkiNotes(
  notes: AnkiNoteDraft[],
): Promise<Array<NoteId | null>> {
  return invokeAnki<Array<NoteId | null>>("addNotes", { notes });
}

/** Applies a partial field update to one existing note. */
export async function updateAnkiNoteFields(
  note: AnkiNoteFieldUpdate,
): Promise<void> {
  await invokeAnki<null>("updateNoteFields", { note });
}

/** Adds one or more space-delimited tags to existing notes. */
export async function addAnkiNoteTags(
  noteIds: NoteId[],
  tags: string,
): Promise<void> {
  await invokeAnki<null>("addTags", { notes: noteIds, tags });
}

/** Removes one or more space-delimited tags from existing notes. */
export async function removeAnkiNoteTags(
  noteIds: NoteId[],
  tags: string,
): Promise<void> {
  await invokeAnki<null>("removeTags", { notes: noteIds, tags });
}

/** Gets all tags registered in the current Anki collection. */
export function getAnkiTags(): Promise<string[]> {
  return invokeAnki<string[]>("getTags");
}

/** Permanently deletes notes and every card generated from them. */
export async function deleteAnkiNotes(noteIds: NoteId[]): Promise<void> {
  await invokeAnki<null>("deleteNotes", { notes: noteIds });
}
