import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findAnkiNotes } from "../../../anki-api/notes/note-client.js";
import { addAnkiNoteTypeTemplate } from "../../../anki-api/note-types/note-type-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
} from "./note-type-design-utils.js";
import { containsClozeFilter } from "./note-type-definition-validator.js";
import { buildNoteTypeSearchQuery } from "./note-type-schema-utils.js";
import {
  createDesignRevisionIssue,
  hasNoteTypeTemplateName,
  hasSameTemplateDesign,
} from "./note-type-template-utils.js";
import {
  type DesignValidationIssue,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
  noteTypeTemplateHtmlSchema,
  noteTypeTemplateMutationResultSchema,
  noteTypeTemplateNameSchema,
} from "./shared-schemas.js";
import { validateTemplateSide } from "./template-validator.js";

const IMPACT_SAMPLE_LIMIT = 20;

const addNoteTypeTemplateInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    templateName: noteTypeTemplateNameSchema,
    front: noteTypeTemplateHtmlSchema.describe(
      "Complete HTML for the new front side",
    ),
    back: noteTypeTemplateHtmlSchema.describe(
      "Complete HTML for the new back side",
    ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the template without modifying Anki",
      ),
    expectedDesignHash: noteTypeDesignHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-design; required when dryRun is false and blocks stale writes",
      ),
    expectedNoteCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Existing note count returned by the dry run; required when dryRun is false and blocks applying changed impact",
      ),
    confirmCardCreation: z
      .boolean()
      .default(false)
      .describe(
        "Must be true when dryRun is false to confirm that Anki may generate a new card for each existing note",
      ),
  })
  .superRefine(
    (
      {
        dryRun,
        expectedDesignHash,
        expectedNoteCount,
        confirmCardCreation,
      },
      context,
    ) => {
      if (dryRun) {
        return;
      }

      if (expectedDesignHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedDesignHash"],
          message:
            "expectedDesignHash is required when dryRun is false",
        });
      }
      if (expectedNoteCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedNoteCount"],
          message: "expectedNoteCount is required when dryRun is false",
        });
      }
      if (!confirmCardCreation) {
        context.addIssue({
          code: "custom",
          path: ["confirmCardCreation"],
          message:
            "confirmCardCreation must be true when dryRun is false",
        });
      }
    },
  );

type AddNoteTypeTemplateInput = z.infer<
  typeof addNoteTypeTemplateInputSchema
>;

export const addNoteTypeTemplateConfig = {
  title: "Add note type template",
  description:
    "Adds a new card template to a Normal note type. Defaults to dry-run mode and reports how many existing notes may generate a new card.",
  inputSchema: addNoteTypeTemplateInputSchema,
  outputSchema: noteTypeTemplateMutationResultSchema.extend({
    addedTemplate: z.object({
      name: z.string(),
      order: z.number().int().nonnegative(),
      front: z.string(),
      back: z.string(),
    }),
    impact: z.object({
      noteCount: z.number().int().nonnegative(),
      maximumNewCardCount: z.number().int().nonnegative(),
      sampleNoteIds: z.array(z.number().int().positive()),
      sampleTruncated: z.boolean(),
    }),
    cardCreationConfirmed: z.boolean(),
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/** Previews or appends a validated card template to a Normal note type. */
export async function addNoteTypeTemplate({
  modelName,
  templateName,
  front,
  back,
  dryRun,
  expectedDesignHash,
  expectedNoteCount,
  confirmCardCreation,
}: AddNoteTypeTemplateInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const fieldNames = current.noteType.fields.map(({ name }) => name);
  const noteIds = await findAnkiNotes(buildNoteTypeSearchQuery(modelName));
  const issues: DesignValidationIssue[] = [];
  const revisionIssue = createDesignRevisionIssue(
    expectedDesignHash,
    current.designHash,
  );

  if (revisionIssue !== undefined) {
    issues.push(revisionIssue);
  }

  if (hasNoteTypeTemplateName(current.templates, templateName)) {
    issues.push({
      severity: "error",
      code: "template_already_exists",
      path: "templateName",
      message: `A card template named "${templateName}" already exists.`,
    });
  }

  if (current.templates.some((template) => template.front === front)) {
    issues.push({
      severity: "error",
      code: "duplicate_template_front",
      path: "front",
      message:
        "The new front HTML is identical to an existing card template.",
    });
  }

  const currentIsCloze = current.templates.some(
    ({ front: currentFront, back: currentBack }) =>
      containsClozeFilter(currentFront) ||
      containsClozeFilter(currentBack),
  );
  const newTemplateUsesCloze =
    containsClozeFilter(front) || containsClozeFilter(back);

  if (currentIsCloze) {
    issues.push({
      severity: "error",
      code: "cloze_note_type_cannot_add_template",
      path: "templateName",
      message: "A Cloze note type can have only one card template.",
    });
  } else if (newTemplateUsesCloze) {
    issues.push({
      severity: "error",
      code: "cloze_filter_requires_cloze_note_type",
      path: "front",
      message:
        "A Normal note type cannot add a template with {{cloze:Field}} filters.",
    });
  }

  issues.push(
    ...validateTemplateSide({
      html: front,
      fieldNames,
      path: "front",
      requireFieldReference: true,
    }).issues,
    ...validateTemplateSide({
      html: back,
      fieldNames,
      path: "back",
      requireFieldReference: false,
    }).issues,
  );

  if (
    expectedNoteCount !== undefined &&
    expectedNoteCount !== noteIds.length
  ) {
    issues.push({
      severity: "error",
      code: "template_add_impact_changed",
      path: "expectedNoteCount",
      message: `The note type now contains ${noteIds.length} notes instead of the expected ${expectedNoteCount}. Run the dry run again.`,
    });
  }

  if (noteIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "cards_may_be_created",
      path: "templateName",
      message: `Anki may generate up to ${noteIds.length} new cards from this template, depending on the front template and note values.`,
    });
  }

  const canBuildProposal = !hasNoteTypeTemplateName(
    current.templates,
    templateName,
  );
  const addedTemplate = {
    name: templateName,
    order: current.templates.length,
    front,
    back,
  };
  const proposedTemplates = canBuildProposal
    ? [...current.templates, addedTemplate]
    : current.templates.map((template) => ({ ...template }));
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
    addedTemplate,
    impact: {
      noteCount: noteIds.length,
      maximumNewCardCount: noteIds.length,
      sampleNoteIds: noteIds.slice(0, IMPACT_SAMPLE_LIMIT),
      sampleTruncated: noteIds.length > IMPACT_SAMPLE_LIMIT,
    },
    cardCreationConfirmed: confirmCardCreation,
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Added no card template to "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for adding card template "${templateName}" to "${modelName}"; up to ${noteIds.length} new card${noteIds.length === 1 ? "" : "s"} may be generated, and Anki was not changed.`,
      result,
    );
  }

  await addAnkiNoteTypeTemplate(modelName, {
    Name: templateName,
    Front: front,
    Back: back,
  });
  const updated = await loadNoteTypeDesign(modelName);

  if (!hasSameTemplateDesign(updated.templates, proposedTemplates)) {
    throw new Error(
      `Anki returned an unexpected template design after adding "${templateName}"`,
    );
  }

  return createToolResult(
    `Added card template "${templateName}" to note type "${modelName}". Anki may have generated cards for matching existing notes.`,
    {
      ...result,
      applied: true,
      afterDesignHash: updated.designHash,
      templates: updated.templates,
    },
  );
}
