import { invokeAnki } from "../anki-request.js";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { getV1NameMap } from "../v1/anki-v1-collection-client.js";
import type {
  AnkiCreatedNoteType,
  AnkiCreateNoteTypeInput,
  AnkiCreateNoteTypeTemplate,
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
  sortField,
}: AnkiCreateNoteTypeInput): Promise<AnkiCreatedNoteType> {
  if (sortField !== undefined && !useAnkiV1("noteTypes.create")) {
    throw new AnkiRequestError("configuration", "noteTypes.create", "Specifying sortField requires ANKI_API_MODE=v1.", false);
  }
  return invokeAnki<AnkiCreatedNoteType>("createModel", {
    modelName,
    inOrderFields,
    cardTemplates,
    css,
    isCloze,
    ...(sortField === undefined ? {} : { sortField }),
  });
}

/** Gets every Anki note type name and its numeric model ID. */
export async function getAnkiNoteTypeNameMap(): Promise<AnkiNoteTypeNameMap> {
  if (useAnkiV1("noteTypes.list")) return getV1NameMap("noteTypes.list");
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

/** Permanently removes a field and its values from every note of a type. */
export function removeAnkiNoteTypeField(
  modelName: string,
  fieldName: string,
): Promise<null> {
  return invokeAnki<null>("modelFieldRemove", {
    modelName,
    fieldName,
  });
}

/** Adds a new card template to the end of a note type's template list. */
export function addAnkiNoteTypeTemplate(
  modelName: string,
  template: AnkiCreateNoteTypeTemplate,
): Promise<null> {
  return invokeAnki<null>("modelTemplateAdd", {
    modelName,
    template,
  });
}

/** Renames one card template without changing its HTML. */
export function renameAnkiNoteTypeTemplate(
  modelName: string,
  oldTemplateName: string,
  newTemplateName: string,
): Promise<null> {
  return invokeAnki<null>("modelTemplateRename", {
    modelName,
    oldTemplateName,
    newTemplateName,
  });
}

/** Moves one card template to a zero-based order. */
export function repositionAnkiNoteTypeTemplate(
  modelName: string,
  templateName: string,
  newOrder: number,
): Promise<null> {
  return invokeAnki<null>("modelTemplateReposition", {
    modelName,
    templateName,
    index: newOrder,
  });
}

/** Permanently removes a card template and its generated cards. */
export function removeAnkiNoteTypeTemplate(
  modelName: string,
  templateName: string,
): Promise<null> {
  return invokeAnki<null>("modelTemplateRemove", {
    modelName,
    templateName,
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
export async function updateAnkiNoteTypeStyling(
  modelName: string,
  css: string,
): Promise<null> {
  const result = await invokeAnki<unknown>("updateModelStyling", {
    model: {
      name: modelName,
      css,
    },
  });
  if (result !== null) {
    throw new Error("AnkiConnect returned an invalid CSS update acknowledgement");
  }
  return null;
}
