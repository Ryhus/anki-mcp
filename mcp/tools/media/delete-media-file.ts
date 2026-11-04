import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { deleteAnkiMediaFile } from "../../../anki-api/media/media-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadAnkiMediaFile } from "./media-loader.js";
import { findMediaUsage } from "./media-usage-utils.js";
import {
  mediaFileDescriptorSchema,
  mediaFilenameSchema,
  mediaSha256Schema,
  mediaUsageSchema,
} from "./shared-schemas.js";

const deleteMediaFileInputSchema = z
  .object({
    filename: mediaFilenameSchema,
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "Inspect exact bytes and all detectable references without deleting the file",
      ),
    expectedSha256: mediaSha256Schema
      .optional()
      .describe(
        "File hash returned by the dry run; required when applying",
      ),
    expectedReferenceCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Reference count returned by the dry run; required when applying",
      ),
    confirmDeletion: z
      .boolean()
      .default(false)
      .describe("Must be true when applying media deletion"),
    confirmBrokenReferences: z
      .boolean()
      .default(false)
      .describe(
        "Must be true when applying deletion while Notes, Card Templates, or CSS still reference the file",
      ),
  })
  .superRefine(
    (
      {
        dryRun,
        expectedSha256,
        expectedReferenceCount,
        confirmDeletion,
      },
      context,
    ) => {
      if (dryRun) {
        return;
      }

      if (expectedSha256 === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedSha256"],
          message: "expectedSha256 is required when dryRun is false",
        });
      }
      if (expectedReferenceCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedReferenceCount"],
          message:
            "expectedReferenceCount is required when dryRun is false",
        });
      }
      if (!confirmDeletion) {
        context.addIssue({
          code: "custom",
          path: ["confirmDeletion"],
          message: "confirmDeletion must be true when dryRun is false",
        });
      }
    },
  );

type DeleteMediaFileInput = z.infer<
  typeof deleteMediaFileInputSchema
>;

export const deleteMediaFileConfig = {
  title: "Delete media file",
  description:
    "Previews exact Note, Card Template, and CSS references before moving one media file to Anki's media trash. Applying requires reviewed hashes and explicit confirmation.",
  inputSchema: deleteMediaFileInputSchema,
  outputSchema: z.object({
    filename: z.string(),
    dryRun: z.boolean(),
    exists: z.boolean(),
    applied: z.boolean(),
    file: mediaFileDescriptorSchema.nullable(),
    usage: mediaUsageSchema,
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Deletes only after a complete, unchanged impact scan. */
export async function deleteMediaFile({
  filename,
  dryRun,
  expectedSha256,
  expectedReferenceCount,
  confirmDeletion: _confirmDeletion,
  confirmBrokenReferences,
}: DeleteMediaFileInput): Promise<CallToolResult> {
  const [loaded, usage] = await Promise.all([
    loadAnkiMediaFile(filename),
    findMediaUsage(filename),
  ]);
  const blockers: string[] = [];
  const warnings = [
    "Automatic Anki collection backups do not include media files.",
    "Deleting or breaking references can propagate to other devices during media synchronization.",
  ];

  if (!usage.scanComplete) {
    blockers.push(
      `Native search found ${usage.candidateNoteCount} candidate notes, but only ${usage.scannedNoteCount} were scanned; deletion requires a complete candidate reference scan.`,
    );
  }

  if (
    loaded !== null &&
    expectedSha256 !== undefined &&
    expectedSha256 !== loaded.descriptor.sha256
  ) {
    blockers.push(
      "The media bytes changed after the dry run; inspect the file again.",
    );
  }

  if (
    expectedReferenceCount !== undefined &&
    expectedReferenceCount !== usage.totalReferenceCount
  ) {
    blockers.push(
      `The reference count changed from ${expectedReferenceCount} to ${usage.totalReferenceCount}; run the dry run again.`,
    );
  }

  if (
    !dryRun &&
    usage.totalReferenceCount > 0 &&
    !confirmBrokenReferences
  ) {
    blockers.push(
      `The file still has ${usage.totalReferenceCount} reference${usage.totalReferenceCount === 1 ? "" : "s"}; confirmBrokenReferences must be true to delete it anyway.`,
    );
  }

  const result = {
    filename,
    dryRun,
    exists: loaded !== null,
    applied: false,
    file: loaded?.descriptor ?? null,
    usage,
    blockers,
    warnings,
  };

  if (loaded === null) {
    return createToolResult(
      `Media file "${filename}" was not found; nothing was deleted.`,
      result,
    );
  }

  if (blockers.length > 0) {
    return createToolResult(
      `Deleted no media file because ${blockers.length} safety blocker${blockers.length === 1 ? "" : "s"} must be resolved.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run found ${usage.totalReferenceCount} reference${usage.totalReferenceCount === 1 ? "" : "s"} to "${filename}"; Anki was not changed.`,
      result,
    );
  }

  await deleteAnkiMediaFile(filename);
  const afterDelete = await loadAnkiMediaFile(filename);

  if (afterDelete !== null) {
    throw new Error(
      `AnkiConnect did not delete media file "${filename}"`,
    );
  }

  return createToolResult(
    `Deleted media file "${filename}" and moved it to Anki's media trash${usage.totalReferenceCount === 0 ? "." : `, leaving ${usage.totalReferenceCount} broken reference${usage.totalReferenceCount === 1 ? "" : "s"} as explicitly confirmed.`}`,
    { ...result, applied: true },
  );
}
