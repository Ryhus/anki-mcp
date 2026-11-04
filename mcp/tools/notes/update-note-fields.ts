import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  updateNoteFieldsInputSchema,
  updateNoteFieldsOutputSchema,
  type UpdateNoteFieldsInput,
} from "./note-field-update-schemas.js";
import {
  applyAndVerifyNoteFieldUpdates,
  prepareNoteFieldUpdates,
} from "./note-field-update-utils.js";
import { loadNotes } from "./note-loader.js";

export const updateNoteFieldsConfig = {
  title: "Update note fields",
  description:
    "Previews partial field patches by default. To apply, set dryRun to false and provide expectedFieldHashes for every submitted field from get-note-details or a dry run. Validates the complete batch before writing and verifies saved values. Each submitted field replaces its complete value, including HTML.",
  inputSchema: updateNoteFieldsInputSchema,
  outputSchema: updateNoteFieldsOutputSchema,
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Rejects stale batches before writing and reports success only after readback. */
export async function updateNoteFields(
  input: UpdateNoteFieldsInput,
): Promise<CallToolResult> {
  const { notes, missingNoteIds } = await loadNotes(
    input.updates.map(({ noteId }) => noteId),
  );
  const { preparedUpdates, changes, unchangedNoteIds, rejectedUpdates } =
    prepareNoteFieldUpdates(input, notes);
  const result = {
    dryRun: input.dryRun,
    applied: false,
    verified: false,
    changedFieldCount: changes.filter(({ changed }) => changed).length,
    changes,
    updatedNotes: [],
    unchangedNoteIds,
    missingNoteIds,
    rejectedUpdates,
  };

  if (missingNoteIds.length > 0 || rejectedUpdates.length > 0) {
    return createToolResult(
      `Applied no field updates because ${missingNoteIds.length} note ID(s) were missing and ${rejectedUpdates.length} update(s) were invalid or stale.`,
      result,
    );
  }

  if (input.dryRun) {
    return createToolResult(
      `Dry run prepared ${result.changedFieldCount} field change(s); Anki was not changed. Use each beforeFieldHash as the expectedFieldHashes entry when applying the same patch.`,
      result,
    );
  }

  await applyAndVerifyNoteFieldUpdates(preparedUpdates);

  return createToolResult(
    `Updated and verified ${preparedUpdates.length} note(s); ${unchangedNoteIds.length} already contained the requested field values.`,
    {
      ...result,
      applied: true,
      verified: true,
      updatedNotes: preparedUpdates.map(({ noteId, fields }) => ({
        noteId,
        updatedFields: Object.keys(fields),
      })),
    },
  );
}
