import type { AnkiNoteDraft } from "../../../anki-api/notes/note-types.js";
import { getDeckNameMap } from "../../../anki-api/decks/deck-client.js";
import {
  getAnkiNoteTypeFieldNames,
  getAnkiNoteTypeNameMap,
} from "../../../anki-api/note-types/note-type-client.js";
import { validateAnkiNoteDrafts } from "../../../anki-api/notes/note-client.js";
import {
  type NoteDraft,
  type NoteDraftValidation,
} from "./shared-schemas.js";
import { canonicalizeFields } from "./note-field-utils.js";
import { unique } from "./note-utils.js";

export interface PreparedNoteDrafts {
  notes: Array<AnkiNoteDraft | null>;
  validations: NoteDraftValidation[];
}

/**
 * Validates local deck, note-type, and field contracts before asking
 * AnkiConnect to apply its duplicate and card-generation rules.
 */
export async function prepareNoteDrafts(
  drafts: NoteDraft[],
): Promise<PreparedNoteDrafts> {
  const [decks, noteTypes] = await Promise.all([
    getDeckNameMap(),
    getAnkiNoteTypeNameMap(),
  ]);
  const existingModelNames = unique(
    drafts
      .map(({ modelName }) => modelName)
      .filter((modelName) => noteTypes[modelName] !== undefined),
  );
  const fieldNameEntries = await Promise.all(
    existingModelNames.map(
      async (modelName) =>
        [
          modelName,
          await getAnkiNoteTypeFieldNames(modelName),
        ] as const,
    ),
  );
  const fieldsByModel = new Map(fieldNameEntries);
  const preparedNotes = drafts.map((draft) =>
    prepareDraft(draft, decks, noteTypes, fieldsByModel),
  );
  const remotelyValidatedIndexes: number[] = [];
  const remotelyValidatedNotes: AnkiNoteDraft[] = [];

  preparedNotes.forEach((prepared, index) => {
    if (typeof prepared !== "string") {
      remotelyValidatedIndexes.push(index);
      remotelyValidatedNotes.push(prepared);
    }
  });

  const remoteValidations =
    remotelyValidatedNotes.length === 0
      ? []
      : await validateAnkiNoteDrafts(remotelyValidatedNotes);

  if (remoteValidations.length !== remotelyValidatedNotes.length) {
    throw new Error(
      "AnkiConnect returned misaligned note validation results",
    );
  }

  const remoteValidationByIndex = new Map(
    remotelyValidatedIndexes.map((draftIndex, remoteIndex) => {
      const validation = remoteValidations[remoteIndex];

      if (validation === undefined) {
        throw new Error(
          "AnkiConnect omitted a note validation result",
        );
      }

      return [draftIndex, validation] as const;
    }),
  );
  const notes: Array<AnkiNoteDraft | null> = preparedNotes.map((prepared) =>
    typeof prepared === "string" ? null : prepared,
  );
  const validations = preparedNotes.map(
    (prepared, index): NoteDraftValidation => {
      if (typeof prepared === "string") {
        return { index, canCreate: false, error: prepared };
      }

      const remote = remoteValidationByIndex.get(index);

      if (remote === undefined) {
        throw new Error(`Missing validation for note draft ${index}`);
      }

      return {
        index,
        canCreate: remote.canAdd,
        error: remote.canAdd
          ? null
          : (remote.error ?? "Anki rejected the note"),
      };
    },
  );

  return { notes, validations };
}

function prepareDraft(
  draft: NoteDraft,
  decks: Record<string, number>,
  noteTypes: Record<string, number>,
  fieldsByModel: Map<string, string[]>,
): AnkiNoteDraft | string {
  if (decks[draft.deckName] === undefined) {
    return `Deck not found: ${draft.deckName}`;
  }

  if (noteTypes[draft.modelName] === undefined) {
    return `Note type not found: ${draft.modelName}`;
  }

  const fieldNames = fieldsByModel.get(draft.modelName);

  if (fieldNames === undefined) {
    return `Could not load fields for note type: ${draft.modelName}`;
  }

  const canonicalFields = canonicalizeFields(draft.fields, fieldNames);

  if (typeof canonicalFields === "string") {
    return canonicalFields;
  }

  if (
    draft.options.duplicateScope === "collection" &&
    draft.options.duplicateScopeDeckName !== undefined
  ) {
    return "duplicateScopeDeckName requires duplicateScope to be deck";
  }

  const duplicateDeckName =
    draft.options.duplicateScopeDeckName ?? draft.deckName;

  if (
    draft.options.duplicateScope === "deck" &&
    decks[duplicateDeckName] === undefined
  ) {
    return `Duplicate-scope deck not found: ${duplicateDeckName}`;
  }

  return {
    deckName: draft.deckName,
    modelName: draft.modelName,
    fields: canonicalFields,
    tags: unique(draft.tags),
    options: {
      allowDuplicate: draft.options.allowDuplicate,
      duplicateScope: draft.options.duplicateScope,
      duplicateScopeOptions: {
        ...(draft.options.duplicateScope === "deck"
          ? { deckName: duplicateDeckName }
          : {}),
        checkChildren: draft.options.checkChildren,
        checkAllModels: draft.options.checkAllModels,
      },
    },
  };
}
