import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { renameAnkiNoteTypeField } from "../../../anki-api/note-types/note-type-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
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
  noteTypeFieldNameSchema,
  noteTypeNameSchema,
  noteTypeSchemaHashSchema,
} from "./shared-schemas.js";

const renameNoteTypeFieldInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    oldFieldName: noteTypeFieldNameSchema,
    newFieldName: newNoteTypeFieldNameSchema,
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the rename without modifying Anki",
      ),
    expectedSchemaHash: noteTypeSchemaHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-schema; required when dryRun is false and blocks stale writes",
      ),
  })
  .superRefine(
    (
      { oldFieldName, newFieldName, dryRun, expectedSchemaHash },
      context,
    ) => {
      if (oldFieldName === newFieldName) {
        context.addIssue({
          code: "custom",
          path: ["newFieldName"],
          message: "The new field name must differ from the current name",
        });
      }

      if (!dryRun && expectedSchemaHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedSchemaHash"],
          message: "expectedSchemaHash is required when dryRun is false",
        });
      }
    },
  );

type RenameNoteTypeFieldInput = z.infer<
  typeof renameNoteTypeFieldInputSchema
>;

export const renameNoteTypeFieldConfig = {
  title: "Rename note type field",
  description:
    "Renames a field across every note of one note type while preserving its values. Anki updates template references to the renamed field.",
  inputSchema: renameNoteTypeFieldInputSchema,
  outputSchema: noteTypeFieldMutationResultSchema.extend({
    renamedField: z.object({
      previousName: z.string(),
      name: z.string(),
      order: z.number().int().nonnegative().nullable(),
    }),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Previews or renames one field after validating the current schema. */
export async function renameNoteTypeField({
  modelName,
  oldFieldName,
  newFieldName,
  dryRun,
  expectedSchemaHash,
}: RenameNoteTypeFieldInput): Promise<CallToolResult> {
  const current = await loadNoteTypeSchema(modelName);
  const previousFieldNames = current.fields.map(({ name }) => name);
  const fieldOrder = previousFieldNames.indexOf(oldFieldName);
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
      path: "oldFieldName",
      message: `Field "${oldFieldName}" was not found in note type "${modelName}".`,
    });
  }

  if (previousFieldNames.includes(newFieldName)) {
    issues.push({
      severity: "error",
      code: "field_already_exists",
      path: "newFieldName",
      message: `Field "${newFieldName}" already exists in note type "${modelName}".`,
    });
  }

  const canBuildProposal =
    fieldOrder !== -1 && !previousFieldNames.includes(newFieldName);
  const proposedFieldNames = previousFieldNames.map((name) =>
    canBuildProposal && name === oldFieldName ? newFieldName : name,
  );
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
    renamedField: {
      previousName: oldFieldName,
      name: newFieldName,
      order: fieldOrder === -1 ? null : fieldOrder,
    },
    validation,
    scopeWarning: NOTE_TYPE_FIELD_SCOPE_WARNING,
  };

  if (!validation.valid) {
    return createToolResult(
      `Renamed no field in "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for renaming field "${oldFieldName}" to "${newFieldName}" in "${modelName}"; Anki was not changed.`,
      result,
    );
  }

  await renameAnkiNoteTypeField(
    modelName,
    oldFieldName,
    newFieldName,
  );
  const updated = await loadNoteTypeSchema(modelName);
  const updatedFieldNames = updated.fields.map(({ name }) => name);

  if (!hasSameFieldOrder(updatedFieldNames, proposedFieldNames)) {
    throw new Error(
      `Anki returned an unexpected field schema after renaming "${oldFieldName}"`,
    );
  }

  return createToolResult(
    `Renamed field "${oldFieldName}" to "${newFieldName}" in note type "${modelName}". Existing values were preserved.`,
    {
      ...result,
      applied: true,
      afterSchemaHash: updated.schemaHash,
      fields: updated.fields,
    },
  );
}
