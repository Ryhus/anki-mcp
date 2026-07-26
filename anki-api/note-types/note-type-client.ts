import { invokeAnki } from "../anki-request.js";
import type {
  AnkiCreatedNoteType,
  AnkiCreateNoteTypeInput,
  AnkiNoteTypeNameMap,
  AnkiNoteTypeStyling,
  AnkiNoteTypeTemplateMap,
  AnkiNoteTypeTemplates,
  AnkiNoteTypeTemplateUpdates,
} from "./note-type-types.js";

/** Creates a new Anki note type with fields, templates, and shared CSS. */
export function createAnkiNoteType({
  modelName,
  inOrderFields,
  cardTemplates,
  css,
  isCloze,
}: AnkiCreateNoteTypeInput): Promise<AnkiCreatedNoteType> {
  return invokeAnki<AnkiCreatedNoteType>("createModel", {
    modelName,
    inOrderFields,
    cardTemplates,
    css,
    isCloze,
  });
}

/** Gets every Anki note type name and its numeric model ID. */
export function getAnkiNoteTypeNameMap(): Promise<AnkiNoteTypeNameMap> {
  return invokeAnki<AnkiNoteTypeNameMap>("modelNamesAndIds");
}

/** Gets the ordered field names defined by one Anki note type. */
export function getAnkiNoteTypeFieldNames(
  modelName: string,
): Promise<string[]> {
  return invokeAnki<string[]>("modelFieldNames", { modelName });
}

/**
 * Gets the fields used on the question and answer sides of every card
 * template defined by one Anki note type.
 */
export function getAnkiNoteTypeTemplateFields(
  modelName: string,
): Promise<AnkiNoteTypeTemplateMap> {
  return invokeAnki<AnkiNoteTypeTemplateMap>("modelFieldsOnTemplates", {
    modelName,
  });
}

/** Gets the front and back HTML for every card template in a note type. */
export function getAnkiNoteTypeTemplates(
  modelName: string,
): Promise<AnkiNoteTypeTemplates> {
  return invokeAnki<AnkiNoteTypeTemplates>("modelTemplates", {
    modelName,
  });
}

/** Gets the shared CSS used by every card generated from a note type. */
export function getAnkiNoteTypeStyling(
  modelName: string,
): Promise<AnkiNoteTypeStyling> {
  return invokeAnki<AnkiNoteTypeStyling>("modelStyling", {
    modelName,
  });
}

/** Adds a field to a note type, optionally at a zero-based order. */
export function addAnkiNoteTypeField(
  modelName: string,
  fieldName: string,
  order?: number,
): Promise<null> {
  return invokeAnki<null>("modelFieldAdd", {
    modelName,
    fieldName,
    ...(order === undefined ? {} : { index: order }),
  });
}

/** Renames a note-type field while preserving its note values. */
export function renameAnkiNoteTypeField(
  modelName: string,
  oldFieldName: string,
  newFieldName: string,
): Promise<null> {
  return invokeAnki<null>("modelFieldRename", {
    modelName,
    oldFieldName,
    newFieldName,
  });
}

/** Moves a field to a zero-based order within its note type. */
export function repositionAnkiNoteTypeField(
  modelName: string,
  fieldName: string,
  newOrder: number,
): Promise<null> {
  return invokeAnki<null>("modelFieldReposition", {
    modelName,
    fieldName,
    index: newOrder,
  });
}

/**
 * Updates selected front or back templates.
 *
 * Anki applies the update to the note type, so every card generated from it
 * immediately uses the new templates.
 */
export function updateAnkiNoteTypeTemplates(
  modelName: string,
  templates: AnkiNoteTypeTemplateUpdates,
): Promise<null> {
  return invokeAnki<null>("updateModelTemplates", {
    model: {
      name: modelName,
      templates,
    },
  });
}

/**
 * Replaces the CSS shared by all cards generated from one note type.
 */
export function updateAnkiNoteTypeStyling(
  modelName: string,
  css: string,
): Promise<null> {
  return invokeAnki<null>("updateModelStyling", {
    model: {
      name: modelName,
      css,
    },
  });
}
