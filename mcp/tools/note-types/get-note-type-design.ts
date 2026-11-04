import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadNoteTypeDesign } from "./note-type-design-utils.js";
import {
  noteTypeDesignSchema,
  noteTypeNameSchema,
} from "./shared-schemas.js";

const getNoteTypeDesignInputSchema = z.object({
  modelName: noteTypeNameSchema,
});

type GetNoteTypeDesignInput = z.infer<
  typeof getNoteTypeDesignInputSchema
>;

export const getNoteTypeDesignConfig = {
  title: "Get note type design",
  description:
    "Returns the editable front/back HTML, shared CSS, fields, and revision hash for one Anki note type. Use this before proposing design changes.",
  inputSchema: getNoteTypeDesignInputSchema,
  outputSchema: noteTypeDesignSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Loads the complete design contract an LLM needs before editing it. */
export async function getNoteTypeDesign({
  modelName,
}: GetNoteTypeDesignInput): Promise<CallToolResult> {
  const design = await loadNoteTypeDesign(modelName);

  return createToolResult(
    `Loaded ${design.templates.length} template${design.templates.length === 1 ? "" : "s"} and shared CSS for note type "${modelName}". ${design.scopeWarning}`,
    design,
  );
}
