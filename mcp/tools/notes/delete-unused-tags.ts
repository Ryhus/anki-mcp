import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  deleteUnusedTagRegistrations, findUnusedTagRegistrations, openTagMaintenance, readTagRegistry,
  TAG_CLEANUP_MAX_TAGS,
} from "../../../anki-api/notes/tag-maintenance-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.strictObject({
  dryRun: z.boolean().default(true).describe("Preview without modifying Anki."),
  expectedImpactHash: hashSchema.optional().describe("Hash from the reviewed tag cleanup preview."),
  confirmDeletion: z.boolean().default(false).describe("Confirm cleanup of unused tags across the active collection."),
});

export const deleteUnusedTagsConfig = {
  title: "Delete unused Anki tags",
  description: "Previews and removes tag registrations that no Note uses in the active collection. Does not remove tags from Notes or delete Notes or Cards. Requires AnkiConnect v1 and confirmation of the reviewed preview.",
  inputSchema,
  outputSchema: z.object({
    profile: z.string().nullable(), dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(),
    impactHash: hashSchema.nullable(), registeredTagCount: z.number().int().nonnegative(),
    unusedTags: z.array(z.string()).max(TAG_CLEANUP_MAX_TAGS), deletedCount: z.number().int().nonnegative(),
    blockers: z.array(z.string()), warnings: z.array(z.string()),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function deleteUnusedTags({
  dryRun, expectedImpactHash, confirmDeletion,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openTagMaintenance();
  const registry = await readTagRegistry(ctx);
  const unusedTags = await findUnusedTagRegistrations(ctx, registry);
  if (!sameTags(registry, await readTagRegistry(ctx))) {
    throw new Error("The tag registry changed during the scan. Preview tag cleanup again.");
  }

  const hash = createHash("sha256").update(JSON.stringify([
    "delete-unused-tags", 1, ctx.session, registry, unusedTags,
  ])).digest("hex");
  const blockers: string[] = [];
  if (expectedImpactHash !== undefined && expectedImpactHash !== hash) {
    blockers.push("The reviewed tag inventory, tag usage, or collection session changed. Preview again.");
  }
  if (!dryRun && (!confirmDeletion || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmDeletion: true and the reviewed expectedImpactHash.");
  }
  const result = {
    profile: ctx.profile ?? null, dryRun, applied: false, verified: false,
    impactHash: blockers.length === 0 ? hash : null, registeredTagCount: registry.length, unusedTags, deletedCount: 0, blockers,
    warnings: [
      "Cleanup is collection-wide. An unused parent registration may disappear while its used subtags remain.",
      "Anki decides which registrations are unused at write time. Concurrent changes can race with the final cleanup.",
    ],
  };
  if (blockers.length > 0) return createToolResult("No tags were deleted; resolve the cleanup blockers.", result);
  if (dryRun) return createToolResult(`Dry run: ${unusedTags.length} unused tag registration(s). Anki was not changed.`, result);
  if (unusedTags.length === 0) return createToolResult("No unused tags to delete.", { ...result, verified: true });

  try {
    const deletedCount = await deleteUnusedTagRegistrations(ctx);
    const unused = new Set(unusedTags);
    const saved = await readTagRegistry(ctx);
    if (deletedCount !== unusedTags.length || !sameTags(registry.filter((tag) => !unused.has(tag)), saved)) {
      throw new Error("The native count or saved registry did not match the reviewed cleanup.");
    }
    return createToolResult(`Deleted and verified ${deletedCount} unused tag registration(s).`, {
      ...result, applied: true, verified: true, deletedCount,
    });
  } catch (error) {
    throw new Error(
      `Could not confirm tag cleanup. The tag registry may already have changed; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}
