import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { renameAnkiNoteTypeTemplate } from "../../../anki-api/note-types/note-type-client.js";
import { REVERSIBLE_MUTATION_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
} from "./note-type-design-utils.js";
import {
  createDesignRevisionIssue,
  findNoteTypeTemplate,
  hasSameTemplateDesign,
  normalizeTemplateOrders,
} from "./note-type-template-utils.js";
import {
  type DesignValidationIssue,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
  noteTypeTemplateMutationResultSchema,
  noteTypeTemplateNameSchema,
} from "./shared-schemas.js";

const renameNoteTypeTemplateInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    oldTemplateName: noteTypeTemplateNameSchema,
    newTemplateName: noteTypeTemplateNameSchema,
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the rename without modifying Anki",
      ),
    expectedDesignHash: noteTypeDesignHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-design; required when dryRun is false and blocks stale writes",
      ),
  })
  .superRefine(
    (
      { oldTemplateName, newTemplateName, dryRun, expectedDesignHash },
      context,
    ) => {
      if (oldTemplateName === newTemplateName) {
        context.addIssue({
          code: "custom",
          path: ["newTemplateName"],
          message:
            "The new card template name must differ from the current name",
        });
      }
      if (!dryRun && expectedDesignHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedDesignHash"],
          message:
            "expectedDesignHash is required when dryRun is false",
        });
      }
    },
  );

type RenameNoteTypeTemplateInput = z.infer<
  typeof renameNoteTypeTemplateInputSchema
>;

export const renameNoteTypeTemplateConfig = {
  title: "Rename note type template",
  description:
    "Renames one card template without changing its order, HTML, generated cards, or review history. Defaults to dry-run mode.",
  inputSchema: renameNoteTypeTemplateInputSchema,
  outputSchema: noteTypeTemplateMutationResultSchema.extend({
    renamedTemplate: z.object({
      previousName: z.string(),
      name: z.string(),
      order: z.number().int().nonnegative().nullable(),
    }),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Previews or renames one card template after a revision check. */
export async function renameNoteTypeTemplate({
  modelName,
  oldTemplateName,
  newTemplateName,
  dryRun,
  expectedDesignHash,
}: RenameNoteTypeTemplateInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const existing = findNoteTypeTemplate(
    current.templates,
    oldTemplateName,
  );
  const conflictingTemplate = current.templates.find(
    ({ name }) =>
      name !== oldTemplateName &&
      name.toLowerCase() === newTemplateName.toLowerCase(),
  );
  const issues: DesignValidationIssue[] = [];
  const revisionIssue = createDesignRevisionIssue(
    expectedDesignHash,
    current.designHash,
  );

  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
  }
  if (existing === undefined) {
    issues.push({
      severity: "error",
      code: "template_not_found",
      path: "oldTemplateName",
      message: `Card template "${oldTemplateName}" was not found.`,
    });
  }
  if (conflictingTemplate !== undefined) {
    issues.push({
      severity: "error",
      code: "template_already_exists",
      path: "newTemplateName",
      message: `A card template named "${newTemplateName}" already exists.`,
    });
  }

  const canBuildProposal =
    existing !== undefined && conflictingTemplate === undefined;
  const proposedTemplates = normalizeTemplateOrders(
    current.templates.map((template) =>
      canBuildProposal && template.name === oldTemplateName
        ? { ...template, name: newTemplateName }
        : { ...template },
    ),
  );
  const validation = createDesignValidation(issues);
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed: canBuildProposal,
    beforeDesignHash: current.designHash,
    afterDesignHash: calculateNoteTypeDesignHash(
      current.css,
      proposedTemplates,
    ),
    previousTemplates: current.templates,
    templates: proposedTemplates,
    renamedTemplate: {
      previousName: oldTemplateName,
      name: newTemplateName,
      order: existing?.order ?? null,
    },
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Renamed no card template in "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for renaming card template "${oldTemplateName}" to "${newTemplateName}" in "${modelName}"; Anki was not changed.`,
      result,
    );
  }

  await renameAnkiNoteTypeTemplate(
    modelName,
    oldTemplateName,
    newTemplateName,
  );
  const updated = await loadNoteTypeDesign(modelName);

  if (!hasSameTemplateDesign(updated.templates, proposedTemplates)) {
    throw new Error(
      `Anki returned an unexpected template design after renaming "${oldTemplateName}"`,
    );
  }

  return createToolResult(
    `Renamed card template "${oldTemplateName}" to "${newTemplateName}" in note type "${modelName}".`,
    {
      ...result,
      applied: true,
      afterDesignHash: updated.designHash,
      templates: updated.templates,
    },
  );
}
