import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getAnkiNoteTypeFieldNames,
  getAnkiNoteTypeNameMap,
  getAnkiNoteTypeTemplateFields,
} from "../../../anki-api/note-types/note-type-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  noteTypeDetailsSchema,
  noteTypeNameSchema,
  type NoteTypeDetails,
} from "./shared-schemas.js";

const getNoteTypeSchemaInputSchema = z.object({
  modelName: noteTypeNameSchema,
});

type GetNoteTypeSchemaInput = z.infer<
  typeof getNoteTypeSchemaInputSchema
>;

export const getNoteTypeSchemaConfig = {
  title: "Get note type schema",
  description:
    "Returns the ordered fields and card-template field usage for one Anki note type. Use this before creating notes.",
  inputSchema: getNoteTypeSchemaInputSchema,
  outputSchema: z.object({
    noteType: noteTypeDetailsSchema,
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Loads the field contract an LLM needs to create a valid Anki note. */
export async function getNoteTypeSchema({
  modelName,
}: GetNoteTypeSchemaInput): Promise<CallToolResult> {
  const noteTypes = await getAnkiNoteTypeNameMap();
  const id = noteTypes[modelName];

  if (id === undefined) {
    throw new Error(`Note type not found: ${modelName}`);
  }

  const [fieldNames, templates] = await Promise.all([
    getAnkiNoteTypeFieldNames(modelName),
    getAnkiNoteTypeTemplateFields(modelName),
  ]);

  const noteType: NoteTypeDetails = {
    id,
    name: modelName,
    fields: fieldNames.map((name, order) => ({ name, order })),
    cardTemplates: Object.entries(templates).map(
      ([name, [questionFields, answerFields]]) => ({
        name,
        questionFields,
        answerFields,
      }),
    ),
  };

  return createToolResult(
    `Note type "${modelName}" has ${noteType.fields.length} field${noteType.fields.length === 1 ? "" : "s"} and ${noteType.cardTemplates.length} card template${noteType.cardTemplates.length === 1 ? "" : "s"}.`,
    { noteType },
  );
}
