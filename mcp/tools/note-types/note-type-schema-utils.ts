import { createHash } from "node:crypto";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import {
  getAnkiNoteTypeFieldNames,
  getAnkiNoteTypeNameMap,
  getAnkiNoteTypeTemplateFields,
} from "../../../anki-api/note-types/note-type-client.js";
import {
  findManagedNoteTypeFieldState,
  getManagedNoteTypeTemplateFields,
} from "../../../anki-api/note-types/note-type-management-client.js";
import type { AnkiNoteTypeTemplateMap } from "../../../anki-api/note-types/note-type-types.js";
import { openV1Adapter } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import type {
  DesignValidationIssue,
  NoteTypeDetails,
} from "./shared-schemas.js";

export const NOTE_TYPE_FIELD_SCOPE_WARNING =
  "The field schema belongs to the note type and applies to every note that uses it.";

/** Loads the complete field schema and its optimistic-concurrency hash. */
export async function loadNoteTypeSchema(
  modelName: string,
): Promise<NoteTypeDetails> {
  if (useAnkiV1("noteTypes.get")) {
    const ctx = await openV1Adapter({});
    const type = await findManagedNoteTypeFieldState(ctx, { name: modelName });
    if (type?.name !== modelName) throw new Error(`Note type not found: ${modelName}`);
    const templates = await getManagedNoteTypeTemplateFields(ctx, { id: type.id });
    return toNoteTypeDetails(type.id, type.name, type.fields.map(({ name }) => name), type.sortField, templates);
  }

  const noteTypes = await getAnkiNoteTypeNameMap();
  const id = noteTypes[modelName];

  if (id === undefined) {
    throw new Error(`Note type not found: ${modelName}`);
  }

  const [fieldNames, templates] = await Promise.all([
    getAnkiNoteTypeFieldNames(modelName),
    getAnkiNoteTypeTemplateFields(modelName),
  ]);

  return toNoteTypeDetails(id, modelName, fieldNames, null, templates);
}

function toNoteTypeDetails(
  id: number, modelName: string, fieldNames: string[], sortField: string | null, templates: AnkiNoteTypeTemplateMap,
): NoteTypeDetails {
  return {
    id,
    name: modelName,
    fields: toOrderedFields(fieldNames),
    sortField,
    cardTemplates: Object.entries(templates).map(
      ([name, [questionFields, answerFields]]) => ({
        name,
        questionFields,
        answerFields,
      }),
    ),
    schemaHash: calculateNoteTypeSchemaHash(fieldNames),
  };
}

/** Hashes ordered field names for stale-write protection. */
export function calculateNoteTypeSchemaHash(
  fieldNames: string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(fieldNames))
    .digest("hex");
}

/** Creates a revision error when the field schema changed after inspection. */
export function createSchemaRevisionIssue(
  expectedSchemaHash: string | undefined,
  currentSchemaHash: string,
): DesignValidationIssue | undefined {
  if (
    expectedSchemaHash === undefined ||
    expectedSchemaHash === currentSchemaHash
  ) {
    return undefined;
  }

  return {
    severity: "error",
    code: "note_type_schema_changed",
    path: "expectedSchemaHash",
    message:
      "The note type field schema changed after it was read. Load it again before applying an update.",
  };
}

/** Returns field names with one field moved to a new zero-based order. */
export function repositionFieldNames(
  fieldNames: string[],
  fieldName: string,
  newOrder: number,
): string[] {
  const currentOrder = fieldNames.indexOf(fieldName);

  if (currentOrder === -1) {
    return [...fieldNames];
  }

  const reordered = [...fieldNames];
  const [field] = reordered.splice(currentOrder, 1);

  if (field === undefined) {
    return [...fieldNames];
  }

  reordered.splice(newOrder, 0, field);
  return reordered;
}

export function toOrderedFields(
  fieldNames: string[],
): Array<{ name: string; order: number }> {
  return fieldNames.map((name, order) => ({ name, order }));
}

export function hasSameFieldOrder(
  left: string[],
  right: string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

/** Builds an exact Anki search for every note of one note type. */
export function buildNoteTypeSearchQuery(modelName: string): string {
  return `note:"${escapeAnkiSearchLiteral(modelName)}"`;
}

/** Builds an exact search for non-empty values in one note-type field. */
export function buildNonEmptyFieldSearchQuery(
  modelName: string,
  fieldName: string,
): string {
  return `${buildNoteTypeSearchQuery(modelName)} "${escapeAnkiSearchLiteral(fieldName)}:_*"`;
}

export function escapeAnkiSearchLiteral(value: string): string {
  return value.replace(/[\\_*"]/g, (character) => `\\${character}`);
}
