import type { AnkiCreateNoteTypeInput } from "../../../anki-api/note-types/note-type-types.js";
import type { NoteTypeDesign } from "./shared-schemas.js";

export interface NoteTypeCloneDefinition
  extends Omit<AnkiCreateNoteTypeInput, "modelName"> {
  isClozeDetected: boolean;
}

/**
 * Converts an editable note-type design into an AnkiConnect createModel
 * definition while preserving field and template order.
 */
export function buildNoteTypeCloneDefinition(
  design: NoteTypeDesign,
  isClozeOverride?: boolean,
): NoteTypeCloneDefinition {
  const isClozeDetected = design.templates.some(
    ({ front, back }) =>
      containsClozeFilter(front) || containsClozeFilter(back),
  );

  return {
    inOrderFields: design.noteType.fields
      .toSorted((left, right) => left.order - right.order)
      .map(({ name }) => name),
    cardTemplates: design.templates
      .toSorted((left, right) => left.order - right.order)
      .map(({ name, front, back }) => ({
        Name: name,
        Front: front,
        Back: back,
      })),
    css: design.css,
    isCloze: isClozeOverride ?? isClozeDetected,
    isClozeDetected,
  };
}

function containsClozeFilter(html: string): boolean {
  return /{{[^{}]*\bcloze\s*:/i.test(html);
}
