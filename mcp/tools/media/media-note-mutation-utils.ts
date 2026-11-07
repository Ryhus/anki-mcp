import { updateAnkiNoteFields } from "../../../anki-api/notes/note-client.js";
import { loadNotes } from "../notes/note-loader.js";
import { resolveNoteFieldName } from "./media-note-utils.js";
import { calculateFieldHash } from "./media-reference-utils.js";

export interface MediaFieldMutationTarget {
  noteId: number;
  fieldName: string;
  filename: string;
  expectedFieldHash?: string | undefined;
}

export interface ResolvedMediaFieldTarget {
  index: number;
  noteId: number;
  fieldName: string;
  filename: string;
  previousValue: string;
  beforeFieldHash: string;
}

export interface MediaFieldMutationError {
  index: number;
  noteId: number;
  fieldName: string;
  filename: string;
  error: string;
}

export interface ApplicableMediaFieldChange {
  noteId: number;
  fieldName: string;
  changed: boolean;
  proposedValue: string;
}

/** Resolves notes, canonical field casing, values, and stale-write hashes. */
export async function resolveMediaFieldTargets(
  targets: MediaFieldMutationTarget[],
): Promise<{
  resolvedTargets: ResolvedMediaFieldTarget[];
  errors: MediaFieldMutationError[];
}> {
  const { notes } = await loadNotes(
    targets.map(({ noteId }) => noteId),
  );
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const resolvedTargets: ResolvedMediaFieldTarget[] = [];
  const errors: MediaFieldMutationError[] = [];

  targets.forEach((target, index) => {
    const note = notesById.get(target.noteId);

    if (note === undefined) {
      errors.push({ ...target, index, error: "Note was not found" });
      return;
    }

    const fieldName = resolveNoteFieldName(note, target.fieldName);

    if (fieldName === null) {
      errors.push({
        ...target,
        index,
        error: `Field is not defined by note type "${note.modelName}"`,
      });
      return;
    }

    const previousValue = note.fields[fieldName]?.value;

    if (previousValue === undefined) {
      errors.push({
        ...target,
        index,
        fieldName,
        error: "Anki omitted the requested field value",
      });
      return;
    }

    const beforeFieldHash = calculateFieldHash(previousValue);

    if (
      target.expectedFieldHash !== undefined &&
      target.expectedFieldHash !== beforeFieldHash
    ) {
      errors.push({
        ...target,
        index,
        fieldName,
        error:
          "Field changed after the dry run; load the current value and preview again",
      });
      return;
    }

    resolvedTargets.push({
      index,
      noteId: target.noteId,
      fieldName,
      filename: target.filename,
      previousValue,
      beforeFieldHash,
    });
  });

  return { resolvedTargets, errors };
}

/** Applies changed fields and verifies their complete values after reloading. */
export async function applyAndVerifyMediaFieldChanges(
  changes: ApplicableMediaFieldChange[],
): Promise<void> {
  for (const change of changes) {
    if (!change.changed) {
      continue;
    }

    await updateAnkiNoteFields({
      id: change.noteId,
      fields: { [change.fieldName]: change.proposedValue },
    });
  }

  const noteIds = [...new Set(changes.map(({ noteId }) => noteId))];
  const { notes, missingNoteIds } = await loadNotes(noteIds);

  if (missingNoteIds.length > 0) {
    throw new Error(
      `Could not verify updated note IDs: ${missingNoteIds.join(", ")}`,
    );
  }

  const expectedByField = new Map(
    changes.map((change) => [
      createFieldKey(change.noteId, change.fieldName),
      change.proposedValue,
    ]),
  );

  for (const note of notes) {
    for (const [fieldName, field] of Object.entries(note.fields)) {
      const expected = expectedByField.get(
        createFieldKey(note.noteId, fieldName),
      );

      if (expected !== undefined && field.value !== expected) {
        throw new Error(
          `Anki did not preserve the expected media change in note ${note.noteId} field "${fieldName}"`,
        );
      }
    }
  }
}

function createFieldKey(noteId: number, fieldName: string): string {
  return `${noteId}:${fieldName}`;
}
