import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { noteIdSchema } from "../notes/shared-schemas.js";
import { loadAnkiMediaFiles } from "./media-loader.js";
import {
  applyAndVerifyMediaFieldChanges,
  resolveMediaFieldTargets,
} from "./media-note-mutation-utils.js";
import {
  attachMediaReferenceToField,
  calculateFieldHash,
} from "./media-reference-utils.js";
import {
  createFieldPreview,
  isAttachableMediaKind,
} from "./media-utils.js";
import {
  expectedFieldHashSchema,
  MEDIA_MUTATION_BATCH_LIMIT,
  mediaFieldMutationErrorSchema,
  mediaFilenameSchema,
  mediaReferencePlacementSchema,
} from "./shared-schemas.js";

const attachmentSchema = z.object({
  noteId: noteIdSchema,
  fieldName: z.string().trim().min(1).max(500),
  filename: mediaFilenameSchema,
  placement: mediaReferencePlacementSchema,
  altText: z.string().max(1_000).optional(),
  expectedFieldHash: expectedFieldHashSchema
    .optional()
    .describe(
      "Current field hash returned by the dry run; required when applying",
    ),
});

const attachMediaToNotesInputSchema = z
  .object({
    attachments: z
      .array(attachmentSchema)
      .min(1)
      .max(MEDIA_MUTATION_BATCH_LIMIT)
      .refine(
        (attachments) =>
          new Set(
            attachments.map(
              ({ noteId, fieldName }) =>
                `${noteId}:${fieldName.toLowerCase()}`,
            ),
          ).size === attachments.length,
        {
          message:
            "Each note field can appear only once in an attachment batch",
        },
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "Preview exact field hashes and references without modifying Anki",
      ),
  })
  .superRefine(({ attachments, dryRun }, context) => {
    if (dryRun) {
      return;
    }

    attachments.forEach((attachment, index) => {
      if (attachment.expectedFieldHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "expectedFieldHash"],
          message:
            "expectedFieldHash is required for every applied attachment",
        });
      }
    });
  });

type AttachMediaToNotesInput = z.infer<
  typeof attachMediaToNotesInputSchema
>;

const mediaFieldChangeSchema = z.object({
  noteId: noteIdSchema,
  fieldName: z.string(),
  filename: z.string(),
  kind: z.enum(["image", "audio", "video"]),
  placement: z.enum(["append", "prepend"]),
  reference: z.string(),
  changed: z.boolean(),
  beforeFieldHash: expectedFieldHashSchema,
  afterFieldHash: expectedFieldHashSchema,
  previousPreview: z.string(),
  proposedPreview: z.string(),
});

export const attachMediaToNotesConfig = {
  title: "Attach media to notes",
  description:
    "Safely appends or prepends references to existing Anki media without replacing unrelated note-field HTML. Defaults to dry-run mode.",
  inputSchema: attachMediaToNotesInputSchema,
  outputSchema: z.object({
    dryRun: z.boolean(),
    applied: z.boolean(),
    changedFieldCount: z.number().int().nonnegative(),
    changes: z.array(mediaFieldChangeSchema),
    errors: z.array(mediaFieldMutationErrorSchema),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Builds a complete batch before changing any note field. */
export async function attachMediaToNotes({
  attachments,
  dryRun,
}: AttachMediaToNotesInput): Promise<CallToolResult> {
  const { resolvedTargets, errors: targetErrors } =
    await resolveMediaFieldTargets(attachments);
  const mediaFiles = await loadAnkiMediaFiles(
    attachments.map(({ filename }) => filename),
  );
  const changes: Array<z.infer<typeof mediaFieldChangeSchema>> = [];
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
    const attachment = attachments[target.index];

    if (attachment === undefined) {
      throw new Error("Resolved media attachment index was lost");
    }

    const loadedMedia = mediaFiles.get(target.filename);

    if (loadedMedia === null || loadedMedia === undefined) {
      errors.push({
        index: target.index,
        noteId: target.noteId,
        fieldName: target.fieldName,
        filename: target.filename,
        error: "Media file was not found",
      });
      continue;
    }

    if (!isAttachableMediaKind(loadedMedia.descriptor.kind)) {
      errors.push({
        index: target.index,
        noteId: target.noteId,
        fieldName: target.fieldName,
        filename: target.filename,
        error: `Media kind "${loadedMedia.descriptor.kind}" cannot be attached to a note field`,
      });
      continue;
    }

    if (!loadedMedia.descriptor.contentDetected) {
      errors.push({
        index: target.index,
        noteId: target.noteId,
        fieldName: target.fieldName,
        filename: target.filename,
        error: "Media type could not be verified from the file contents",
      });
      continue;
    }

    if (
      attachment.altText !== undefined &&
      loadedMedia.descriptor.kind !== "image"
    ) {
      errors.push({
        index: target.index,
        noteId: target.noteId,
        fieldName: target.fieldName,
        filename: target.filename,
        error: "altText is supported only for image references",
      });
      continue;
    }

    const proposed = attachMediaReferenceToField(
      target.previousValue,
      target.filename,
      loadedMedia.descriptor.kind,
      attachment.placement,
      attachment.altText,
    );

    changes.push({
      noteId: target.noteId,
      fieldName: target.fieldName,
      filename: target.filename,
      kind: loadedMedia.descriptor.kind,
      placement: attachment.placement,
      reference: proposed.reference,
      changed: proposed.changed,
      beforeFieldHash: target.beforeFieldHash,
      afterFieldHash: calculateFieldHash(proposed.value),
      previousPreview: createFieldPreview(target.previousValue),
      proposedPreview: createFieldPreview(proposed.value),
    });
    applicableChanges.push({
      noteId: target.noteId,
      fieldName: target.fieldName,
      changed: proposed.changed,
      proposedValue: proposed.value,
    });
  }

  const changedFieldCount = changes.filter(
    ({ changed }) => changed,
  ).length;

  if (errors.length > 0) {
    return createToolResult(
      `Attached no media because ${errors.length} attachment${errors.length === 1 ? "" : "s"} failed validation.`,
      {
        dryRun,
        applied: false,
        changedFieldCount: 0,
        changes,
        errors,
      },
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run prepared ${changedFieldCount} media attachment${changedFieldCount === 1 ? "" : "s"}; Anki was not changed.`,
      {
        dryRun,
        applied: false,
        changedFieldCount,
        changes,
        errors: [],
      },
    );
  }

  await applyAndVerifyMediaFieldChanges(applicableChanges);

  return createToolResult(
    `Attached media to ${changedFieldCount} note field${changedFieldCount === 1 ? "" : "s"}; ${changes.length - changedFieldCount} already contained the requested reference.`,
    {
      dryRun,
      applied: true,
      changedFieldCount,
      changes,
      errors: [],
    },
  );
}
