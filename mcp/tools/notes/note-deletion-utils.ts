import { createHash } from "node:crypto";
import { createAnkiAction, invokeAnkiMulti } from "../../../anki-api/anki-request.js";
import type { AnkiNoteInfo, AnkiNoteInfoResult } from "../../../anki-api/notes/note-types.js";
import { calculateNoteFieldHash } from "./note-field-utils.js";
import { normalizeLoadedNotes } from "./note-loader.js";
import {
  NOTE_DELETION_CARD_SAMPLE_LIMIT,
  NOTE_DELETION_FIELD_PREVIEW_LIMIT,
  NOTE_DELETION_FIELD_SAMPLE_LIMIT,
  type NoteDeletionImpact,
} from "./note-deletion-schemas.js";

const VERIFICATION_CARD_QUERY_LIMIT = 250;

/** Loads the active profile and exact selected Notes in one read-only batch. */
export async function loadNoteDeletionScope(noteIds: number[]) {
  const [profileName, rawNotes] = await invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"),
    createAnkiAction<AnkiNoteInfoResult[]>("notesInfo", { notes: noteIds }),
  ] as const);
  if (typeof profileName !== "string" || profileName.trim().length === 0) {
    throw new Error("AnkiConnect did not return a valid active profile; deletion impact cannot be reviewed.");
  }
  if (!Array.isArray(rawNotes)) {
    throw new Error("AnkiConnect did not return a valid notesInfo result; deletion impact cannot be reviewed.");
  }
  const loaded = normalizeLoadedNotes(noteIds, rawNotes);
  const cardOwners = new Map<number, number>();
  for (const note of loaded.notes) {
    if (note.profile !== undefined && note.profile !== profileName) {
      throw new Error(`AnkiConnect returned Note ${note.noteId} from a different profile; deletion impact cannot be reviewed.`);
    }
    const fields = Object.values(note.fields);
    if (Array.isArray(note.fields) || fields.length === 0 || fields.some((field) =>
      !Number.isSafeInteger(field.order) || field.order < 0)) {
      throw new Error(`AnkiConnect returned incomplete or invalid fields for Note ${note.noteId}; deletion impact cannot be reviewed.`);
    }
    for (const cardId of note.cards) {
      if (!Number.isSafeInteger(cardId) || cardId <= 0) {
        throw new Error(`AnkiConnect returned an invalid Card ID for Note ${note.noteId}; deletion impact cannot be reviewed.`);
      }
      const owner = cardOwners.get(cardId);
      if (owner !== undefined && owner !== note.noteId) {
        throw new Error(`AnkiConnect assigned Card ${cardId} to multiple selected Notes; deletion impact cannot be reviewed.`);
      }
      cardOwners.set(cardId, note.noteId);
    }
  }
  return { profileName, ...loaded };
}

/**
 * Hashes full Note content and ownership, not previews. Request, tag, field-map,
 * and Card ordering do not affect identity. Card scheduling is not included.
 */
export function calculateNoteDeletionImpactHash(
  profileName: string, noteIds: number[], notes: AnkiNoteInfo[],
): string {
  const snapshot = {
    version: 1,
    profileName,
    noteIds: sortedIds(noteIds),
    notes: [...notes].sort((left, right) => left.noteId - right.noteId).map((note) => ({
      noteId: note.noteId, profile: note.profile ?? null,
      modelName: note.modelName, modifiedAt: note.mod,
      tags: [...new Set(note.tags)].sort(),
      fields: Object.keys(note.fields).sort().map((name) => {
        const field = note.fields[name]!;
        return [name, field.order, calculateNoteFieldHash(field.value)];
      }),
      cardIds: sortedIds(note.cards),
    })),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** Builds bounded human-review samples while keeping exact impact counts. */
export function describeNoteDeletionImpact(noteIds: number[], notes: AnkiNoteInfo[]): NoteDeletionImpact {
  return {
    requestedNoteCount: sortedIds(noteIds).length,
    noteCount: notes.length,
    cardCount: new Set(notes.flatMap((note) => note.cards)).size,
    notes: notes.map((note) => {
      const fields = Object.entries(note.fields).sort(([, left], [, right]) => left.order - right.order);
      const sampleFields = fields.slice(0, NOTE_DELETION_FIELD_SAMPLE_LIMIT);
      const cardIds = sortedIds(note.cards);
      return {
        noteId: note.noteId, modelName: note.modelName,
        fieldPreviews: Object.fromEntries(sampleFields.map(([name, field]) => [
          name, field.value.slice(0, NOTE_DELETION_FIELD_PREVIEW_LIMIT),
        ])),
        fieldPreviewsTruncated: fields.length > sampleFields.length ||
          sampleFields.some(([, field]) => field.value.length > NOTE_DELETION_FIELD_PREVIEW_LIMIT),
        cardCount: cardIds.length,
        sampleCardIds: cardIds.slice(0, NOTE_DELETION_CARD_SAMPLE_LIMIT),
        cardIdsTruncated: cardIds.length > NOTE_DELETION_CARD_SAMPLE_LIMIT,
      };
    }),
  };
}

/**
 * Verifies absence with native searches, not missing/invalid notesInfo objects.
 * Queries contain only validated numeric IDs and all reads are batched together.
 */
export async function verifyNoteDeletion(profileName: string, noteIds: number[], cardIds: number[]): Promise<void> {
  const uniqueCardIds = sortedIds(cardIds);
  const cardQueries = [];
  for (let offset = 0; offset < uniqueCardIds.length; offset += VERIFICATION_CARD_QUERY_LIMIT) {
    cardQueries.push(createAnkiAction<number[]>("findCards", {
      query: idQuery("cid", uniqueCardIds.slice(offset, offset + VERIFICATION_CARD_QUERY_LIMIT)),
    }));
  }
  const [activeProfile, remainingNoteIds, ...cardResults] = await invokeAnkiMulti([
    createAnkiAction<string>("getActiveProfile"),
    createAnkiAction<number[]>("findNotes", { query: idQuery("nid", noteIds) }),
    ...cardQueries,
  ] as const);
  if (activeProfile !== profileName) {
    throw new Error("The active Anki profile changed during deletion verification.");
  }
  if (!Array.isArray(remainingNoteIds) || cardResults.some((result) => !Array.isArray(result))) {
    throw new Error("AnkiConnect returned invalid deletion verification search results.");
  }
  const remainingCardIds = cardResults.flat();
  if (remainingNoteIds.length > 0 || remainingCardIds.length > 0) {
    throw new Error(
      `Still present: ${remainingNoteIds.length} selected Notes and ${remainingCardIds.length} reviewed Cards. Inspect them before retrying.`,
    );
  }
}

function sortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function idQuery(kind: "nid" | "cid", ids: number[]): string {
  return ids.map((id) => `${kind}:${id}`).join(" or ");
}
