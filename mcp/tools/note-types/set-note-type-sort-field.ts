import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  findManagedNoteTypeFieldState, openNoteTypeManagement, setManagedNoteTypeSortField,
} from "../../../anki-api/note-types/note-type-management-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { hasSameFieldOrder } from "./note-type-schema-utils.js";
import { noteTypeIdSchema, noteTypeSortFieldNameSchema } from "./shared-schemas.js";

const impactHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.object({
  noteTypeId: noteTypeIdSchema.describe("Stable ID from list-note-types or get-note-type-schema"),
  sortField: noteTypeSortFieldNameSchema.describe("Exact existing field name from get-note-type-schema"),
  dryRun: z.boolean().default(true).describe("Preview without modifying Anki"),
  expectedImpactHash: impactHashSchema.optional().describe("Hash from the reviewed sort-field preview"),
  confirmChange: z.boolean().default(false),
});

export const setNoteTypeSortFieldConfig = {
  title: "Set note type sort field",
  description: "Previews changing which field supplies the Anki Browser's Sort Field column for an existing Note Type. Does not reorder fields, edit templates, or change review scheduling. Applying requires the reviewed impact hash and explicit confirmation. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    noteTypeId: noteTypeIdSchema,
    modelName: z.string().nullable(),
    beforeSortField: z.string().nullable(),
    sortField: z.string(),
    dryRun: z.boolean(),
    applied: z.boolean(),
    verified: z.boolean(),
    impactHash: impactHashSchema.nullable(),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

export async function setNoteTypeSortField({
  noteTypeId, sortField, dryRun, expectedImpactHash, confirmChange,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openNoteTypeManagement();
  const current = await findManagedNoteTypeFieldState(ctx, { id: noteTypeId });
  const fieldNames = current?.fields.map(({ name }) => name) ?? [];
  const blockers: string[] = [];
  let impactHash: string | null = null;
  if (current === null) {
    blockers.push("No Note Type was found with the requested ID.");
  } else if (!fieldNames.includes(sortField)) {
    blockers.push("The requested sort field is not an exact field name on this Note Type. Read get-note-type-schema.");
  } else {
    impactHash = createHash("sha256").update(JSON.stringify([
      "set-note-type-sort-field", 1, ctx.session, noteTypeId, current.name, fieldNames, current.sortField, sortField,
    ])).digest("hex");
  }
  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The reviewed sort-field change no longer matches the active collection and Note Type schema. Preview it again.");
  }
  if (!dryRun && (!confirmChange || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmChange: true and the reviewed expectedImpactHash.");
  }

  const result = {
    noteTypeId, modelName: current?.name ?? null, beforeSortField: current?.sortField ?? null,
    sortField, dryRun, applied: false, verified: false, impactHash, blockers,
    warnings: [
      "The Browser's Sort Field column changes for every Note of this type. The order of fields and the first field used for duplicate checks stay the same.",
      "Preview and apply are separate. Concurrent edits can race with the final update.",
    ],
  };
  if (current === null || blockers.length > 0) {
    return createToolResult("No sort field was changed; resolve the blockers.", result);
  }
  if (current.sortField === sortField) {
    return createToolResult("The Note Type already uses the requested sort field.", { ...result, verified: !dryRun });
  }
  if (dryRun) return createToolResult("Dry run: reviewed the sort-field change. Anki was not changed.", result);

  try {
    await setManagedNoteTypeSortField(ctx, noteTypeId, sortField);
    const saved = await findManagedNoteTypeFieldState(ctx, { id: noteTypeId });
    if (saved?.name !== current.name || saved.sortField !== sortField ||
        !hasSameFieldOrder(fieldNames, saved.fields.map(({ name }) => name))) {
      throw new Error("The saved sort field or Note Type schema does not match the reviewed change.");
    }
  } catch (error) {
    throw new Error(
      `Could not confirm the sort-field change of Note Type ${noteTypeId}. It may already have changed; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  return createToolResult("Changed the Note Type's sort field and verified the unchanged field order.", {
    ...result, applied: true, verified: true,
  });
}
