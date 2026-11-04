import { updateAnkiNoteFields } from "../../../anki-api/notes/note-client.js";
import type { AnkiNoteInfo } from "../../../anki-api/notes/note-types.js";
import {
  calculateNoteFieldHash,
  canonicalizeFields,
} from "./note-field-utils.js";
import type {
  NoteFieldChange,
  RejectedNoteFieldUpdate,
  UpdateNoteFieldsInput,
} from "./note-field-update-schemas.js";
import { loadNotes } from "./note-loader.js";

const FIELD_CHANGE_PREVIEW_LIMIT = 1_000;

export interface PreparedNoteFieldUpdate {
  noteId: number;
  fields: Record<string, string>;
}

/** Validates field names and expected versions for the complete batch. */
export function prepareNoteFieldUpdates(
  { updates, dryRun }: UpdateNoteFieldsInput,
  notes: AnkiNoteInfo[],
): {
  preparedUpdates: PreparedNoteFieldUpdate[];
  changes: NoteFieldChange[];
  unchangedNoteIds: number[];
  rejectedUpdates: RejectedNoteFieldUpdate[];
} {
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const preparedUpdates: PreparedNoteFieldUpdate[] = [];
  const changes: NoteFieldChange[] = [];
  const unchangedNoteIds: number[] = [];
  const rejectedUpdates: RejectedNoteFieldUpdate[] = [];

  for (const update of updates) {
    const note = notesById.get(update.noteId);
    if (note === undefined) {
      continue;
    }

    const definedFieldNames = Object.keys(note.fields);
    const fields = canonicalizeFields(update.fields, definedFieldNames);
    const hashes = canonicalizeFields(
      update.expectedFieldHashes ?? {},
      definedFieldNames,
    );

    if (typeof fields === "string") {
      rejectedUpdates.push({ noteId: update.noteId, error: fields });
      continue;
    }
    if (typeof hashes === "string") {
      rejectedUpdates.push({ noteId: update.noteId, error: hashes });
      continue;
    }

    const conflicts: string[] = [];
    const missingHashes: string[] = [];
    const changedFields: Array<[string, string]> = [];

    for (const [fieldName, proposedValue] of Object.entries(fields)) {
      const previousValue = note.fields[fieldName]?.value;
      if (previousValue === undefined) {
        throw new Error(`Anki omitted note ${note.noteId} field "${fieldName}"`);
      }

      const beforeFieldHash = calculateNoteFieldHash(previousValue);
      const expectedHash = hashes[fieldName];
      if (expectedHash !== undefined && expectedHash !== beforeFieldHash) {
        conflicts.push(fieldName);
      } else if (!dryRun && expectedHash === undefined) {
        missingHashes.push(fieldName);
      }

      const changed = previousValue !== proposedValue;
      changes.push({
        noteId: note.noteId,
        fieldName,
        changed,
        beforeFieldHash,
        afterFieldHash: calculateNoteFieldHash(proposedValue),
        previousPreview: previousValue.slice(0, FIELD_CHANGE_PREVIEW_LIMIT),
        proposedPreview: proposedValue.slice(0, FIELD_CHANGE_PREVIEW_LIMIT),
        previewTruncated:
          previousValue.length > FIELD_CHANGE_PREVIEW_LIMIT ||
          proposedValue.length > FIELD_CHANGE_PREVIEW_LIMIT,
      });
      if (changed) {
        changedFields.push([fieldName, proposedValue]);
      }
    }

    const errors: string[] = [];
    if (conflicts.length > 0) {
      errors.push(
        `Fields changed since they were read: ${conflicts.join(", ")}. Read the current values and prepare the patch again.`,
      );
    }
    if (missingHashes.length > 0) {
      errors.push(`Missing expected hashes for fields: ${missingHashes.join(", ")}`);
    }
    if (errors.length > 0) {
      rejectedUpdates.push({ noteId: note.noteId, error: errors.join(" ") });
      continue;
    }

    if (changedFields.length === 0) {
      unchangedNoteIds.push(note.noteId);
    } else {
      preparedUpdates.push({
        noteId: note.noteId,
        fields: Object.fromEntries(changedFields),
      });
    }
  }

  return { preparedUpdates, changes, unchangedNoteIds, rejectedUpdates };
}

/** Writes prepared patches, then confirms exact values without automatic retries. */
export async function applyAndVerifyNoteFieldUpdates(
  updates: PreparedNoteFieldUpdate[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const acknowledgedNoteIds: number[] = [];
  for (const update of updates) {
    try {
      await updateAnkiNoteFields({ id: update.noteId, fields: update.fields });
      acknowledgedNoteIds.push(update.noteId);
    } catch (error) {
      throw new Error(
        `Could not confirm the field update for note ${update.noteId}. Previously acknowledged note IDs: ${acknowledgedNoteIds.join(", ") || "none"}. The failed write may also have reached Anki; later updates were not attempted. No rollback was performed. Inspect the notes before retrying. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  try {
    const { notes, missingNoteIds } = await loadNotes(acknowledgedNoteIds);
    const notesById = new Map(notes.map((note) => [note.noteId, note]));
    const mismatches: string[] = [];

    for (const update of updates) {
      const note = notesById.get(update.noteId);
      if (note === undefined) {
        continue;
      }
      for (const [fieldName, expectedValue] of Object.entries(update.fields)) {
        if (note.fields[fieldName]?.value !== expectedValue) {
          mismatches.push(`note ${update.noteId} field "${fieldName}"`);
        }
      }
    }

    if (missingNoteIds.length > 0 || mismatches.length > 0) {
      throw new Error(
        `Missing note IDs: ${missingNoteIds.join(", ") || "none"}; values did not match for: ${mismatches.join(", ") || "none"}`,
      );
    }
  } catch (error) {
    throw new Error(
      `Field update verification failed. Writes were acknowledged for note IDs: ${acknowledgedNoteIds.join(", ")}. Data may already have changed; no rollback was performed. Inspect the notes before retrying. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
