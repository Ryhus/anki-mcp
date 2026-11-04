import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { repositionAnkiNoteTypeTemplate } from "../../../anki-api/note-types/note-type-client.js";
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
  repositionNoteTypeTemplates,
} from "./note-type-template-utils.js";
import {
  type DesignValidationIssue,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
  noteTypeTemplateMutationResultSchema,
  noteTypeTemplateNameSchema,
} from "./shared-schemas.js";

const repositionNoteTypeTemplateInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    templateName: noteTypeTemplateNameSchema,
    newOrder: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Zero-based card template order. Use 0 to make it the first template.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the new order without modifying Anki",
      ),
    expectedDesignHash: noteTypeDesignHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-design; required when dryRun is false and blocks stale writes",
      ),
  })
  .superRefine(({ dryRun, expectedDesignHash }, context) => {
    if (!dryRun && expectedDesignHash === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedDesignHash"],
        message: "expectedDesignHash is required when dryRun is false",
      });
    }
  });

type RepositionNoteTypeTemplateInput = z.infer<
  typeof repositionNoteTypeTemplateInputSchema
>;

export const repositionNoteTypeTemplateConfig = {
  title: "Reposition note type template",
  description:
    "Moves one card template to a new zero-based order while preserving its HTML and existing card history. Defaults to dry-run mode.",
  inputSchema: repositionNoteTypeTemplateInputSchema,
  outputSchema: noteTypeTemplateMutationResultSchema.extend({
    repositionedTemplate: z.object({
      name: z.string(),
      previousOrder: z.number().int().nonnegative().nullable(),
      newOrder: z.number().int().nonnegative(),
    }),
  }),
  annotations: REVERSIBLE_MUTATION_TOOL_ANNOTATIONS,
};

/** Previews or repositions one card template after a revision check. */
export async function repositionNoteTypeTemplate({
  modelName,
  templateName,
  newOrder,
  dryRun,
  expectedDesignHash,
}: RepositionNoteTypeTemplateInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const existing = findNoteTypeTemplate(current.templates, templateName);
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
      path: "templateName",
      message: `Card template "${templateName}" was not found.`,
    });
  }
  if (newOrder >= current.templates.length) {
    issues.push({
      severity: "error",
      code: "template_order_out_of_range",
      path: "newOrder",
      message: `New template order must be between 0 and ${Math.max(current.templates.length - 1, 0)}.`,
    });
  }

  const canBuildProposal =
    existing !== undefined && newOrder < current.templates.length;
  const proposedTemplates = canBuildProposal
    ? repositionNoteTypeTemplates(
        current.templates,
        templateName,
        newOrder,
      )
    : current.templates.map((template) => ({ ...template }));
  const changed =
    canBuildProposal && existing.order !== newOrder;
  const validation = createDesignValidation(issues);
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed,
    beforeDesignHash: current.designHash,
    afterDesignHash: calculateNoteTypeDesignHash(
      current.css,
      proposedTemplates,
    ),
    previousTemplates: current.templates,
    templates: proposedTemplates,
    repositionedTemplate: {
      name: templateName,
      previousOrder: existing?.order ?? null,
      newOrder,
    },
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Repositioned no card template in "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (!changed) {
    return createToolResult(
      `Card template "${templateName}" is already at order ${newOrder} in "${modelName}".`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for moving card template "${templateName}" from order ${existing.order} to ${newOrder} in "${modelName}"; Anki was not changed.`,
      result,
    );
  }

  await repositionAnkiNoteTypeTemplate(
    modelName,
    templateName,
    newOrder,
  );
  const updated = await loadNoteTypeDesign(modelName);

  if (!hasSameTemplateDesign(updated.templates, proposedTemplates)) {
    throw new Error(
      `Anki returned an unexpected template design after moving "${templateName}"`,
    );
  }

  return createToolResult(
    `Moved card template "${templateName}" from order ${existing.order} to ${newOrder} in note type "${modelName}".`,
    {
      ...result,
      applied: true,
      afterDesignHash: updated.designHash,
      templates: updated.templates,
    },
  );
}
