import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { noteIdSchema } from "../notes/shared-schemas.js";
import {
  applyAndVerifyMediaFieldChanges,
  resolveMediaFieldTargets,
} from "./media-note-mutation-utils.js";
import {
  calculateFieldHash,
  removeMediaReferencesFromField,
} from "./media-reference-utils.js";
import { createFieldPreview } from "./media-utils.js";
import {
  expectedFieldHashSchema,
  MEDIA_MUTATION_BATCH_LIMIT,
  mediaFieldMutationErrorSchema,
  mediaFilenameSchema,
} from "./shared-schemas.js";

const detachmentSchema = z.object({
  noteId: noteIdSchema,
  fieldName: z.string().trim().min(1).max(500),
  filename: mediaFilenameSchema,
  expectedFieldHash: expectedFieldHashSchema
    .optional()
    .describe(
      "Current field hash returned by the dry run; required when applying",
    ),
});

const detachMediaFromNotesInputSchema = z
  .object({
    detachments: z
      .array(detachmentSchema)
      .min(1)
      .max(MEDIA_MUTATION_BATCH_LIMIT)
      .refine(
        (detachments) =>
          new Set(
            detachments.map(
              ({ noteId, fieldName }) =>
                `${noteId}:${fieldName.toLowerCase()}`,
            ),
          ).size === detachments.length,
        {
          message:
            "Each note field can appear only once in a detachment batch",
        },
      ),
    dryRun: z.boolean().default(true),
  })
  .superRefine(({ detachments, dryRun }, context) => {
    if (dryRun) {
      return;
    }

    detachments.forEach((detachment, index) => {
      if (detachment.expectedFieldHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["detachments", index, "expectedFieldHash"],
          message:
            "expectedFieldHash is required for every applied detachment",
        });
      }
    });
  });

type DetachMediaFromNotesInput = z.infer<
  typeof detachMediaFromNotesInputSchema
>;

const mediaFieldDetachmentSchema = z.object({
  noteId: noteIdSchema,
  fieldName: z.string(),
  filename: z.string(),
  removedReferenceCount: z.number().int().nonnegative(),
  changed: z.boolean(),
  beforeFieldHash: expectedFieldHashSchema,
  afterFieldHash: expectedFieldHashSchema,
  previousPreview: z.string(),
  proposedPreview: z.string(),
});

export const detachMediaFromNotesConfig = {
  title: "Detach media from notes",
  description:
    "Removes exact image or sound references from selected note fields without deleting the media file. Defaults to dry-run mode.",
  inputSchema: detachMediaFromNotesInputSchema,
  outputSchema: z.object({
    dryRun: z.boolean(),
    applied: z.boolean(),
    changedFieldCount: z.number().int().nonnegative(),
    removedReferenceCount: z.number().int().nonnegative(),
    changes: z.array(mediaFieldDetachmentSchema),
    errors: z.array(mediaFieldMutationErrorSchema),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Removes only exact source ranges and leaves unrelated HTML untouched. */
export async function detachMediaFromNotes({
  detachments,
  dryRun,
}: DetachMediaFromNotesInput): Promise<CallToolResult> {
  const { resolvedTargets, errors: targetErrors } =
    await resolveMediaFieldTargets(detachments);
  const changes: Array<z.infer<typeof mediaFieldDetachmentSchema>> =
    [];
  const applicableChanges: Array<{
    noteId: number;
    fieldName: string;
    changed: boolean;
    proposedValue: string;
  }> = [];
  const errors: Array<
    z.infer<typeof mediaFieldMutationErrorSchema>
  > = [...targetErrors];

  for (const target of resolvedTargets) {

    const proposed = removeMediaReferencesFromField(
      target.previousValue,
      target.filename,
    );

    changes.push({
      noteId: target.noteId,
      fieldName: target.fieldName,
      filename: target.filename,
      removedReferenceCount: proposed.removedReferenceCount,
      changed: proposed.removedReferenceCount > 0,
      beforeFieldHash: target.beforeFieldHash,
      afterFieldHash: calculateFieldHash(proposed.value),
      previousPreview: createFieldPreview(target.previousValue),
      proposedPreview: createFieldPreview(proposed.value),
    });
    applicableChanges.push({
      noteId: target.noteId,
      fieldName: target.fieldName,
      changed: proposed.removedReferenceCount > 0,
      proposedValue: proposed.value,
    });
  }

  const changedFieldCount = changes.filter(
    ({ changed }) => changed,
  ).length;
  const removedReferenceCount = changes.reduce(
    (total, change) => total + change.removedReferenceCount,
    0,
  );

  if (errors.length > 0) {
    return createToolResult(
      `Detached no media because ${errors.length} detachment${errors.length === 1 ? "" : "s"} failed validation.`,
      {
        dryRun,
        applied: false,
        changedFieldCount: 0,
        removedReferenceCount: 0,
        changes,
        errors,
      },
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run would remove ${removedReferenceCount} media reference${removedReferenceCount === 1 ? "" : "s"} from ${changedFieldCount} note field${changedFieldCount === 1 ? "" : "s"}; Anki was not changed.`,
      {
        dryRun,
        applied: false,
        changedFieldCount,
        removedReferenceCount,
        changes,
        errors: [],
      },
    );
  }

  await applyAndVerifyMediaFieldChanges(applicableChanges);

  return createToolResult(
    `Removed ${removedReferenceCount} media reference${removedReferenceCount === 1 ? "" : "s"} from ${changedFieldCount} note field${changedFieldCount === 1 ? "" : "s"}; the media files were not deleted.`,
    {
      dryRun,
      applied: true,
      changedFieldCount,
      removedReferenceCount,
      changes,
      errors: [],
    },
  );
}
