import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNoteTypeSchema } from "./note-type-schema-utils.js";
import {
  noteTypeDetailsSchema,
  noteTypeNameSchema,
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
    "Returns ordered fields, card-template field usage, and a schema revision hash for one Anki note type. Use this before creating notes or changing fields.",
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
  const noteType = await loadNoteTypeSchema(modelName);

  return createToolResult(
    `Note type "${modelName}" has ${noteType.fields.length} field${noteType.fields.length === 1 ? "" : "s"} and ${noteType.cardTemplates.length} card template${noteType.cardTemplates.length === 1 ? "" : "s"}.`,
    { noteType },
  );
}
