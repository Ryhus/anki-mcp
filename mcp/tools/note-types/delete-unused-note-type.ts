import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  deleteUnusedManagedNoteType, deleteUnusedNoteTypeMethod, findManagedNoteTypeDeletionSnapshot,
  hasNotesOfType, openNoteTypeManagement,
} from "../../../anki-api/note-types/note-type-management-client.js";
import { getV1NameMap } from "../../../anki-api/v1/anki-v1-collection-client.js";
import { orderedJson } from "../../utils/ordered-json.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { noteTypeIdSchema, noteTypeSummarySchema } from "./shared-schemas.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.object({
  noteTypeId: noteTypeIdSchema.describe("Explicit stable ID from list-note-types"),
  dryRun: z.boolean().default(true).describe("Preview without modifying Anki"),
  expectedImpactHash: hashSchema.optional().describe("Hash from the reviewed deletion preview"),
  confirmDeletion: z.boolean().default(false),
});

export const deleteUnusedNoteTypeConfig = {
  title: "Delete unused note type",
  description: "Previews deleting one explicitly selected Note Type. Refuses if any Note uses the type, even without Cards, or if it is the last Note Type. Requires the reviewed impact hash and explicit confirmation to apply. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    noteTypeId: noteTypeIdSchema,
    noteType: noteTypeSummarySchema.extend({ kind: z.enum(["normal", "cloze"]) }).nullable(),
    hasNotes: z.boolean().nullable().describe("Whether any Note uses this type; null if the type could not be inspected."),
    dryRun: z.boolean(),
    applied: z.boolean(),
    verified: z.boolean(),
    impactHash: hashSchema.nullable(),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function deleteUnusedNoteType({
  noteTypeId, dryRun, expectedImpactHash, confirmDeletion,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openNoteTypeManagement(deleteUnusedNoteTypeMethod);
  const list = () => getV1NameMap("noteTypes.list", ctx.session, ctx.options);
  const inventory = await list();
  const entries = Object.entries(inventory);
  const listed = entries.find(([, id]) => id === noteTypeId);
  const type = listed === undefined ? null : await findManagedNoteTypeDeletionSnapshot(ctx, noteTypeId);
  const blockers: string[] = [];
  let hasNotes: boolean | null = null;
  if (listed === undefined) {
    blockers.push("No Note Type was found with the requested ID.");
  } else if (type?.name !== listed[0]) {
    blockers.push("The selected Note Type changed while it was being read. Preview it again.");
  } else {
    hasNotes = await hasNotesOfType(ctx, noteTypeId);
    if (hasNotes) blockers.push("At least one Note still uses this Note Type. No Notes will be deleted.");
    if (entries.length === 1) blockers.push("The last Note Type in the collection cannot be deleted by this tool.");
  }
  const impactHash = blockers.length === 0 && type !== null
    ? createHash("sha256").update(JSON.stringify(orderedJson([
      "delete-unused-note-type", 1, ctx.session, type,
    ]))).digest("hex") : null;

  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The reviewed deletion no longer matches the active collection or Note Type. Preview it again.");
  }
  if (!dryRun && (!confirmDeletion || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmDeletion: true and the reviewed expectedImpactHash.");
  }
  const result = {
    noteTypeId, noteType: type === null ? null : { id: type.id, name: type.name, kind: type.kind },
    hasNotes, dryRun, applied: false, verified: false, impactHash, blockers,
    warnings: [
      "Deleting the unused Note Type removes its definition and design. This tool does not create a backup. Anki may require a full sync.",
      "Preview and apply are separate. Anki rechecks that the type is unused; concurrent changes can still race with the final deletion.",
    ],
  };
  if (blockers.length > 0 || dryRun) return createToolResult(
    blockers.length > 0 ? "No Note Type was deleted; resolve the blockers."
      : "Dry run: the selected Note Type is unused. Anki was not changed.",
    result,
  );

  try {
    await deleteUnusedManagedNoteType(ctx, noteTypeId);
    const remaining = new Set(Object.values(await list()));
    if (remaining.has(noteTypeId) || entries.some(([, id]) => id !== noteTypeId && !remaining.has(id))) {
      throw new Error("Readback did not confirm that only the selected Note Type was removed.");
    }
  } catch (error) {
    throw new Error(
      `Could not confirm deletion of Note Type ${noteTypeId}. It may already have been deleted; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  return createToolResult("Deleted the unused Note Type and verified that the other Note Type IDs remain.", {
    ...result, applied: true, verified: true,
  });
}
