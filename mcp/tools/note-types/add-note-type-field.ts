import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { addAnkiNoteTypeField } from "../../../anki-api/note-types/note-type-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeSchemaHash,
  createSchemaRevisionIssue,
  hasSameFieldOrder,
  loadNoteTypeSchema,
  NOTE_TYPE_FIELD_SCOPE_WARNING,
  toOrderedFields,
} from "./note-type-schema-utils.js";
import {
  type DesignValidationIssue,
  newNoteTypeFieldNameSchema,
  noteTypeFieldMutationResultSchema,
  noteTypeNameSchema,
  noteTypeSchemaHashSchema,
} from "./shared-schemas.js";

const addNoteTypeFieldInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    fieldName: newNoteTypeFieldNameSchema,
    order: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Optional zero-based field order. Use 0 for the first field; omit to append.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the field without modifying Anki",
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

type AddNoteTypeFieldInput = z.infer<
  typeof addNoteTypeFieldInputSchema
>;

export const addNoteTypeFieldConfig = {
  title: "Add note type field",
  description:
    "Adds an empty field to every note of one note type. Defaults to dry-run mode and does not add the field to card templates.",
  inputSchema: addNoteTypeFieldInputSchema,
  outputSchema: noteTypeFieldMutationResultSchema.extend({
    addedField: z.object({
      name: z.string(),
      order: z.number().int().nonnegative(),
    }),
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/** Previews or adds one field after validating the current field schema. */
export async function addNoteTypeField({
  modelName,
  fieldName,
  order,
  dryRun,
  expectedSchemaHash,
}: AddNoteTypeFieldInput): Promise<CallToolResult> {
  const current = await loadNoteTypeSchema(modelName);
  const previousFieldNames = current.fields.map(({ name }) => name);
  const targetOrder = order ?? previousFieldNames.length;
  const issues: DesignValidationIssue[] = [];
  const revisionIssue = createSchemaRevisionIssue(
    expectedSchemaHash,
    current.schemaHash,
  );

  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
  }

  if (previousFieldNames.includes(fieldName)) {
    issues.push({
      severity: "error",
      code: "field_already_exists",
      path: "fieldName",
      message: `Field "${fieldName}" already exists in note type "${modelName}".`,
    });
  }

  if (targetOrder > previousFieldNames.length) {
    issues.push({
      severity: "error",
      code: "field_order_out_of_range",
      path: "order",
      message: `Field order must be between 0 and ${previousFieldNames.length}.`,
    });
  }

  const canBuildProposal =
    !previousFieldNames.includes(fieldName) &&
    targetOrder <= previousFieldNames.length;
  const proposedFieldNames = [...previousFieldNames];

  if (canBuildProposal) {
    proposedFieldNames.splice(targetOrder, 0, fieldName);
  }

  if (
    canBuildProposal &&
    proposedFieldNames[0] !== previousFieldNames[0]
  ) {
    issues.push({
      severity: "warning",
      code: "first_field_changed",
      path: "order",
      message:
        "The new field becomes the first field. Anki uses the first field for duplicate checks, and existing notes will initially have an empty value there.",
    });
  }

  const validation = createDesignValidation(issues);
  const changed = canBuildProposal;
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed,
    beforeSchemaHash: current.schemaHash,
    afterSchemaHash: calculateNoteTypeSchemaHash(proposedFieldNames),
    previousFields: current.fields,
    fields: toOrderedFields(proposedFieldNames),
    addedField: {
      name: fieldName,
      order: targetOrder,
    },
    validation,
    scopeWarning: NOTE_TYPE_FIELD_SCOPE_WARNING,
  };

  if (!validation.valid) {
    return createToolResult(
      `Added no field to "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for adding field "${fieldName}" at order ${targetOrder} to "${modelName}" with ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed.`,
      result,
    );
  }

  await addAnkiNoteTypeField(modelName, fieldName, targetOrder);
  const updated = await loadNoteTypeSchema(modelName);
  const updatedFieldNames = updated.fields.map(({ name }) => name);

  if (!hasSameFieldOrder(updatedFieldNames, proposedFieldNames)) {
    throw new Error(
      `Anki returned an unexpected field order after adding "${fieldName}"`,
    );
  }

  return createToolResult(
    `Added field "${fieldName}" at order ${targetOrder} to note type "${modelName}". Existing notes received an empty value for the field.`,
    {
      ...result,
      applied: true,
      afterSchemaHash: updated.schemaHash,
      fields: updated.fields,
    },
  );
}
