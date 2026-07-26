import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { removeAnkiNoteTypeField } from "../../../anki-api/note-types/note-type-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  buildNonEmptyFieldSearchQuery,
  buildNoteTypeSearchQuery,
  calculateNoteTypeSchemaHash,
  createSchemaRevisionIssue,
  hasSameFieldOrder,
  loadNoteTypeSchema,
  NOTE_TYPE_FIELD_SCOPE_WARNING,
  toOrderedFields,
} from "./note-type-schema-utils.js";
import {
  type DesignValidationIssue,
  noteTypeFieldMutationResultSchema,
  noteTypeFieldNameSchema,
  noteTypeNameSchema,
  noteTypeSchemaHashSchema,
} from "./shared-schemas.js";

const IMPACT_SAMPLE_LIMIT = 20;

const deleteNoteTypeFieldInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    fieldName: noteTypeFieldNameSchema,
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, report the permanent data impact without modifying Anki",
      ),
    expectedSchemaHash: noteTypeSchemaHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-schema; required when dryRun is false and blocks stale writes",
      ),
    expectedNonEmptyNoteCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Non-empty note count returned by the dry run; required when dryRun is false and blocks applying changed impact",
      ),
    confirmDataLoss: z
      .boolean()
      .default(false)
      .describe(
        "Must be true when dryRun is false to confirm permanent deletion of this field's values",
      ),
  })
  .superRefine(
    (
      {
        dryRun,
        expectedSchemaHash,
        expectedNonEmptyNoteCount,
        confirmDataLoss,
      },
      context,
    ) => {
      if (dryRun) {
        return;
      }

      if (expectedSchemaHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedSchemaHash"],
          message: "expectedSchemaHash is required when dryRun is false",
        });
      }

      if (expectedNonEmptyNoteCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedNonEmptyNoteCount"],
          message:
            "expectedNonEmptyNoteCount is required when dryRun is false",
        });
      }

      if (!confirmDataLoss) {
        context.addIssue({
          code: "custom",
          path: ["confirmDataLoss"],
          message:
            "confirmDataLoss must be true when dryRun is false",
        });
      }
    },
  );

type DeleteNoteTypeFieldInput = z.infer<
  typeof deleteNoteTypeFieldInputSchema
>;

const templateReferenceSchema = z.object({
  templateName: z.string(),
  sides: z.array(z.enum(["question", "answer"])),
});

export const deleteNoteTypeFieldConfig = {
  title: "Delete note type field",
  description:
    "Permanently deletes one field and all of its values from every note of a note type. Requires a dry-run impact review, current schema hash, unchanged non-empty note count, and explicit data-loss confirmation.",
  inputSchema: deleteNoteTypeFieldInputSchema,
  outputSchema: noteTypeFieldMutationResultSchema.extend({
    deletedField: z.object({
      name: z.string(),
      order: z.number().int().nonnegative().nullable(),
    }),
    impact: z.object({
      noteCount: z.number().int().nonnegative(),
      nonEmptyNoteCount: z.number().int().nonnegative(),
      sampleNoteIdsWithData: z.array(z.number().int().positive()),
      sampleTruncated: z.boolean(),
    }),
    templateReferences: z.array(templateReferenceSchema),
    dataLossConfirmed: z.boolean(),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/**
 * Previews or permanently removes a field after validating its full impact.
 */
export async function deleteNoteTypeField({
  modelName,
  fieldName,
  dryRun,
  expectedSchemaHash,
  expectedNonEmptyNoteCount,
  confirmDataLoss,
}: DeleteNoteTypeFieldInput): Promise<CallToolResult> {
  const current = await loadNoteTypeSchema(modelName);
  const previousFieldNames = current.fields.map(({ name }) => name);
  const fieldOrder = previousFieldNames.indexOf(fieldName);
  const issues: DesignValidationIssue[] = [];
  const revisionIssue = createSchemaRevisionIssue(
    expectedSchemaHash,
    current.schemaHash,
  );

  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
  }

  if (fieldOrder === -1) {
    issues.push({
      severity: "error",
      code: "field_not_found",
      path: "fieldName",
      message: `Field "${fieldName}" was not found in note type "${modelName}".`,
    });
  }

  if (previousFieldNames.length === 1 && fieldOrder !== -1) {
    issues.push({
      severity: "error",
      code: "cannot_delete_last_field",
      path: "fieldName",
      message: "A note type must retain at least one field.",
    });
  }

  const templateReferences =
    fieldOrder === -1
      ? []
      : current.cardTemplates.flatMap((template) => {
          const sides: Array<"question" | "answer"> = [];

          if (template.questionFields.includes(fieldName)) {
            sides.push("question");
          }
          if (template.answerFields.includes(fieldName)) {
            sides.push("answer");
          }

          return sides.length === 0
            ? []
            : [{ templateName: template.name, sides }];
        });

  if (templateReferences.length > 0) {
    issues.push({
      severity: "error",
      code: "field_used_in_templates",
      path: "fieldName",
      message:
        "Remove this field from every card template before deleting it.",
    });
  }

  const [noteIds, nonEmptyNoteIds] =
    fieldOrder === -1
      ? [[], []]
      : await Promise.all([
          findAnkiNotes(buildNoteTypeSearchQuery(modelName)),
          findAnkiNotes(
            buildNonEmptyFieldSearchQuery(modelName, fieldName),
          ),
        ]);

  if (
    expectedNonEmptyNoteCount !== undefined &&
    expectedNonEmptyNoteCount !== nonEmptyNoteIds.length
  ) {
    issues.push({
      severity: "error",
      code: "field_data_impact_changed",
      path: "expectedNonEmptyNoteCount",
      message: `The field now contains data in ${nonEmptyNoteIds.length} notes instead of the expected ${expectedNonEmptyNoteCount}. Run the dry run again.`,
    });
  }

  const canBuildProposal =
    fieldOrder !== -1 && previousFieldNames.length > 1;
  const proposedFieldNames = canBuildProposal
    ? previousFieldNames.filter((name) => name !== fieldName)
    : [...previousFieldNames];

  if (
    canBuildProposal &&
    proposedFieldNames[0] !== previousFieldNames[0]
  ) {
    issues.push({
      severity: "warning",
      code: "first_field_changed",
      path: "fieldName",
      message:
        "Deleting this field changes the first field. Anki uses the first field for duplicate checks.",
    });
  }

  if (nonEmptyNoteIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "field_values_will_be_deleted",
      path: "fieldName",
      message: `This permanently deletes a non-empty value from ${nonEmptyNoteIds.length} note${nonEmptyNoteIds.length === 1 ? "" : "s"}.`,
    });
  }

  const validation = createDesignValidation(issues);
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed: canBuildProposal,
    beforeSchemaHash: current.schemaHash,
    afterSchemaHash: calculateNoteTypeSchemaHash(proposedFieldNames),
    previousFields: current.fields,
    fields: toOrderedFields(proposedFieldNames),
    deletedField: {
      name: fieldName,
      order: fieldOrder === -1 ? null : fieldOrder,
    },
    impact: {
      noteCount: noteIds.length,
      nonEmptyNoteCount: nonEmptyNoteIds.length,
      sampleNoteIdsWithData: nonEmptyNoteIds.slice(
        0,
        IMPACT_SAMPLE_LIMIT,
      ),
      sampleTruncated: nonEmptyNoteIds.length > IMPACT_SAMPLE_LIMIT,
    },
    templateReferences,
    dataLossConfirmed: confirmDataLoss,
    validation,
    scopeWarning: NOTE_TYPE_FIELD_SCOPE_WARNING,
  };

  if (!validation.valid) {
    return createToolResult(
      `Deleted no field from "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run found ${nonEmptyNoteIds.length} non-empty value${nonEmptyNoteIds.length === 1 ? "" : "s"} across ${noteIds.length} note${noteIds.length === 1 ? "" : "s"} for field "${fieldName}"; Anki was not changed.`,
      result,
    );
  }

  await removeAnkiNoteTypeField(modelName, fieldName);
  const updated = await loadNoteTypeSchema(modelName);
  const updatedFieldNames = updated.fields.map(({ name }) => name);

  if (!hasSameFieldOrder(updatedFieldNames, proposedFieldNames)) {
    throw new Error(
      `Anki returned an unexpected field schema after deleting "${fieldName}"`,
    );
  }

  return createToolResult(
    `Permanently deleted field "${fieldName}" and its values from ${noteIds.length} note${noteIds.length === 1 ? "" : "s"} of note type "${modelName}".`,
    {
      ...result,
      applied: true,
      afterSchemaHash: updated.schemaHash,
      fields: updated.fields,
    },
  );
}
