import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { prepareNoteDrafts } from "./note-draft-validator.js";
import {
  NOTE_BATCH_LIMIT,
  noteDraftSchema,
  noteDraftValidationSchema,
} from "./shared-schemas.js";

const validateNoteDraftsInputSchema = z.object({
  notes: z
    .array(noteDraftSchema)
    .min(1)
    .max(NOTE_BATCH_LIMIT)
    .describe("Candidate notes to validate without creating them"),
});

type ValidateNoteDraftsInput = z.infer<
  typeof validateNoteDraftsInputSchema
>;

export const validateNoteDraftsConfig = {
  title: "Validate note drafts",
  description:
    "Checks candidate notes without creating them. Validates decks, note types, field names, empty-card rules, and Anki duplicate rules.",
  inputSchema: validateNoteDraftsInputSchema,
  outputSchema: z.object({
    validCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    results: z.array(noteDraftValidationSchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Validates candidate notes and returns actionable per-draft errors. */
export async function validateNoteDrafts({
  notes,
}: ValidateNoteDraftsInput): Promise<CallToolResult> {
  const { validations: results } = await prepareNoteDrafts(notes);
  const validCount = results.filter(({ canCreate }) => canCreate).length;
  const invalidCount = results.length - validCount;

  return createToolResult(
    `Validated ${results.length} note draft${results.length === 1 ? "" : "s"}: ${validCount} can be created and ${invalidCount} cannot.`,
    { validCount, invalidCount, results },
  );
}
