import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAnkiNoteTypeNameMap } from "../../../anki-api/note-types/note-type-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  noteTypeSummarySchema,
  type NoteTypeSummary,
} from "./shared-schemas.js";

export const listNoteTypesConfig = {
  title: "List note types",
  description:
    "Lists the Anki note types available for creating notes, including their model IDs.",
  outputSchema: z.object({
    noteTypes: z.array(noteTypeSummarySchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Lists all available note types in stable name order. */
export async function listNoteTypes(): Promise<CallToolResult> {
  const noteTypes: NoteTypeSummary[] = Object.entries(
    await getAnkiNoteTypeNameMap(),
  )
    .map(([name, id]) => ({ id, name }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      }),
    );

  return createToolResult(
    `Found ${noteTypes.length} note type${noteTypes.length === 1 ? "" : "s"}.`,
    { noteTypes },
  );
}
