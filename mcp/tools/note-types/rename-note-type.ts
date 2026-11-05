import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  findManagedNoteType, openNoteTypeRename, renameManagedNoteType,
} from "../../../anki-api/note-types/note-type-management-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { noteTypeIdSchema } from "./shared-schemas.js";

const impactHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.object({
  noteTypeId: noteTypeIdSchema.describe("Stable ID from list-note-types"),
  // Anki normalizes names and strips double quotes; preview the exact name to be sent.
  newName: z.string().min(1).max(500)
    .refine((name) => name.trim() === name && !/["\p{Cc}\p{Cs}]/u.test(name),
      "Use a trimmed name without double quotes, control characters, or invalid Unicode.")
    .transform((name) => name.normalize("NFC")),
  dryRun: z.boolean().default(true).describe("Preview without modifying Anki"),
  expectedImpactHash: impactHashSchema.optional().describe("Hash returned by the reviewed rename preview"),
  confirmRename: z.boolean().default(false),
});

export const renameNoteTypeConfig = {
  title: "Rename note type",
  description: "Previews renaming an existing Note Type by ID. Changes only the type name, not fields, templates, Notes, or Cards. Applying requires the reviewed impact hash and explicit confirmation. Requires AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    noteTypeId: noteTypeIdSchema,
    beforeName: z.string().nullable(),
    newName: z.string(),
    dryRun: z.boolean(),
    applied: z.boolean(),
    verified: z.boolean(),
    impactHash: impactHashSchema.nullable(),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

export async function renameNoteType({
  noteTypeId, newName, dryRun, expectedImpactHash, confirmRename,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openNoteTypeRename();
  const source = await findManagedNoteType(ctx, { id: noteTypeId });
  const blockers: string[] = [];
  let impactHash: string | null = null;
  if (source === null) {
    blockers.push("No Note Type was found with the requested ID.");
  } else {
    const destination = source.name === newName ? source : await findManagedNoteType(ctx, { name: newName });
    if (destination !== null && destination.id !== noteTypeId) {
      blockers.push("Another Note Type already uses the requested name.");
    } else if (destination !== null && destination.name !== source.name) {
      blockers.push("The current name changed during preflight. Preview the rename again.");
    } else {
      impactHash = createHash("sha256").update(JSON.stringify([
        "rename-note-type", 1, ctx.session, noteTypeId, source.name, newName,
      ])).digest("hex");
    }
  }
  if (expectedImpactHash !== undefined && expectedImpactHash !== impactHash) {
    blockers.push("The reviewed rename no longer matches the active collection and current name. Preview it again.");
  }
  if (!dryRun && (!confirmRename || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmRename: true and the reviewed expectedImpactHash.");
  }

  const result = {
    noteTypeId, beforeName: source?.name ?? null, newName, dryRun,
    applied: false, verified: false, impactHash, blockers,
    warnings: [
      "Existing Notes and Cards keep their IDs. Searches or integrations that use the old Note Type name may need updating.",
      "Preview and apply are separate. Concurrent edits can race with the final rename.",
    ],
  };
  if (blockers.length > 0) return createToolResult("No Note Type was renamed; resolve the rename blockers.", result);
  if (source?.name === newName) {
    return createToolResult("The Note Type already has the requested name.", { ...result, verified: !dryRun });
  }
  if (dryRun) return createToolResult("Dry run: reviewed the Note Type rename. Anki was not changed.", result);

  try {
    await renameManagedNoteType(ctx, noteTypeId, newName);
    const saved = await findManagedNoteType(ctx, { id: noteTypeId });
    if (saved?.name !== newName) throw new Error("The saved name does not match the reviewed name.");
  } catch (error) {
    throw new Error(
      `Could not confirm the rename of Note Type ${noteTypeId}. It may already have changed; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  return createToolResult("Renamed the Note Type and verified its new name and unchanged ID.", {
    ...result, applied: true, verified: true,
  });
}
