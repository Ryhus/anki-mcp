import { createHash } from "node:crypto";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { getV1NoteTypeDesign } from "../../../anki-api/v1/anki-v1-collection-client.js";
import {
  getAnkiNoteTypeFieldNames,
  getAnkiNoteTypeNameMap,
  getAnkiNoteTypeStyling,
  getAnkiNoteTypeTemplates,
} from "../../../anki-api/note-types/note-type-client.js";
import type { AnkiNoteTypeTemplates } from "../../../anki-api/note-types/note-type-types.js";
import type {
  NoteTypeDesign,
  NoteTypeTemplateDesign,
} from "./shared-schemas.js";

export const NOTE_TYPE_SCOPE_WARNING =
  "This design belongs to the note type and affects every card generated from it.";

/** Loads the complete editable HTML/CSS design for one Anki note type. */
export async function loadNoteTypeDesign(
  modelName: string,
): Promise<NoteTypeDesign> {
  if (useAnkiV1("noteTypes.get")) {
    const { id, name, fields, css, templates: records } = await getV1NoteTypeDesign(modelName);
    const templates = records.map(({ name, questionHtml, answerHtml }, order) => ({
      name, order, front: questionHtml, back: answerHtml,
    }));
    return {
      noteType: { id, name, fields: fields.map(({ name }, order) => ({ name, order })) },
      css, templates, designHash: calculateNoteTypeDesignHash(css, templates),
      scopeWarning: NOTE_TYPE_SCOPE_WARNING,
    };
  }
  const noteTypes = await getAnkiNoteTypeNameMap();
  const id = noteTypes[modelName];

  if (id === undefined) {
    throw new Error(`Note type not found: ${modelName}`);
  }

  const [fieldNames, styling, ankiTemplates] = await Promise.all([
    getAnkiNoteTypeFieldNames(modelName),
    getAnkiNoteTypeStyling(modelName),
    getAnkiNoteTypeTemplates(modelName),
  ]);
  const templates = normalizeAnkiTemplates(ankiTemplates);

  return {
    noteType: {
      id,
      name: modelName,
      fields: fieldNames.map((name, order) => ({ name, order })),
    },
    css: styling.css,
    templates,
    designHash: calculateNoteTypeDesignHash(styling.css, templates),
    scopeWarning: NOTE_TYPE_SCOPE_WARNING,
  };
}

/** Converts AnkiConnect's template map into a stable ordered representation. */
export function normalizeAnkiTemplates(
  templates: AnkiNoteTypeTemplates,
): NoteTypeTemplateDesign[] {
  return Object.entries(templates).map(([name, template], order) => ({
    name,
    order,
    front: template.Front,
    back: template.Back,
  }));
}

/** Produces a revision hash suitable for optimistic concurrency checks. */
export function calculateNoteTypeDesignHash(
  css: string,
  templates: NoteTypeTemplateDesign[],
): string {
  const canonicalDesign = {
    css,
    templates: templates.map(({ name, order, front, back }) => ({
      name,
      order,
      front,
      back,
    })),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalDesign))
    .digest("hex");
}
