import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { repositionAnkiNoteTypeField } from "../../../anki-api/note-types/note-type-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeSchemaHash,
  createSchemaRevisionIssue,
  hasSameFieldOrder,
  loadNoteTypeSchema,
  NOTE_TYPE_FIELD_SCOPE_WARNING,
  repositionFieldNames,
  toOrderedFields,
} from "./note-type-schema-utils.js";
import {
  type DesignValidationIssue,
  noteTypeFieldMutationResultSchema,
  noteTypeFieldNameSchema,
  noteTypeNameSchema,
  noteTypeSchemaHashSchema,
} from "./shared-schemas.js";

const repositionNoteTypeFieldInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    fieldName: noteTypeFieldNameSchema,
    newOrder: z
      .number()
      .int()
      .nonnegative()
      .describe("Zero-based field order. Use 0 to make this the first field."),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the new order without modifying Anki",
      ),
    expectedSchemaHash: noteTypeSchemaHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-schema; required when dryRun is false and blocks stale writes",
      ),
  })
  .superRefine(({ dryRun, expectedSchemaHash }, context) => {
    if (!dryRun && expectedSchemaHash === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedSchemaHash"],
        message: "expectedSchemaHash is required when dryRun is false",
      });
    }
  });

type RepositionNoteTypeFieldInput = z.infer<
  typeof repositionNoteTypeFieldInputSchema
>;

export const repositionNoteTypeFieldConfig = {
  title: "Reposition note type field",
  description:
    "Moves a note-type field to a new zero-based order while preserving all note values. Defaults to dry-run mode.",
  inputSchema: repositionNoteTypeFieldInputSchema,
  outputSchema: noteTypeFieldMutationResultSchema.extend({
    repositionedField: z.object({
      name: z.string(),
      previousOrder: z.number().int().nonnegative().nullable(),
      newOrder: z.number().int().nonnegative(),
    }),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Previews or repositions one field after validating the current schema. */
export async function repositionNoteTypeField({
  modelName,
  fieldName,
  newOrder,
  dryRun,
  expectedSchemaHash,
}: RepositionNoteTypeFieldInput): Promise<CallToolResult> {
  const current = await loadNoteTypeSchema(modelName);
  const previousFieldNames = current.fields.map(({ name }) => name);
  const previousOrder = previousFieldNames.indexOf(fieldName);
  const issues: DesignValidationIssue[] = [];
  const revisionIssue = createSchemaRevisionIssue(
    expectedSchemaHash,
    current.schemaHash,
  );

  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
  }

  if (previousOrder === -1) {
    issues.push({
      severity: "error",
      code: "field_not_found",
      path: "fieldName",
      message: `Field "${fieldName}" was not found in note type "${modelName}".`,
    });
  }

  if (newOrder >= previousFieldNames.length) {
    issues.push({
      severity: "error",
      code: "field_order_out_of_range",
      path: "newOrder",
      message: `New field order must be between 0 and ${Math.max(previousFieldNames.length - 1, 0)}.`,
    });
  }

  const canBuildProposal =
    previousOrder !== -1 && newOrder < previousFieldNames.length;
  const proposedFieldNames = canBuildProposal
    ? repositionFieldNames(previousFieldNames, fieldName, newOrder)
    : [...previousFieldNames];
  const changed =
    canBuildProposal && previousOrder !== newOrder;

  if (
    changed &&
    proposedFieldNames[0] !== previousFieldNames[0]
  ) {
    issues.push({
      severity: "warning",
      code: "first_field_changed",
      path: "newOrder",
      message:
        "This changes the first field. Anki uses the first field for duplicate checks.",
    });
  }

  const validation = createDesignValidation(issues);
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed,
    beforeSchemaHash: current.schemaHash,
    afterSchemaHash: calculateNoteTypeSchemaHash(proposedFieldNames),
    previousFields: current.fields,
    fields: toOrderedFields(proposedFieldNames),
    repositionedField: {
      name: fieldName,
      previousOrder: previousOrder === -1 ? null : previousOrder,
      newOrder,
    },
    validation,
    scopeWarning: NOTE_TYPE_FIELD_SCOPE_WARNING,
  };

  if (!validation.valid) {
    return createToolResult(
      `Repositioned no field in "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (!changed) {
    return createToolResult(
      `Field "${fieldName}" is already at order ${newOrder} in note type "${modelName}".`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for moving field "${fieldName}" from order ${previousOrder} to ${newOrder} in "${modelName}" with ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed.`,
      result,
    );
  }

  await repositionAnkiNoteTypeField(modelName, fieldName, newOrder);
  const updated = await loadNoteTypeSchema(modelName);
  const updatedFieldNames = updated.fields.map(({ name }) => name);

  if (!hasSameFieldOrder(updatedFieldNames, proposedFieldNames)) {
    throw new Error(
      `Anki returned an unexpected field order after moving "${fieldName}"`,
    );
  }

  return createToolResult(
    `Moved field "${fieldName}" from order ${previousOrder} to ${newOrder} in note type "${modelName}". Existing values were preserved.`,
    {
      ...result,
      applied: true,
      afterSchemaHash: updated.schemaHash,
      fields: updated.fields,
    },
  );
}
