import { invokeAnki } from "../anki-request.js";
import type {
  AnkiNoteTypeNameMap,
  AnkiNoteTypeTemplateMap,
} from "./note-type-types.js";

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
