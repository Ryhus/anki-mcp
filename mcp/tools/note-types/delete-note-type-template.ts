import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  findAnkiCards,
  getAnkiNoteIdsForCards,
} from "../../../anki-api/cards/card-client.js";
import { removeAnkiNoteTypeTemplate } from "../../../anki-api/note-types/note-type-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
} from "./note-type-design-utils.js";
import {
  buildOtherTemplateCardsSearchQuery,
  buildTemplateCardsSearchQuery,
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

const IMPACT_SAMPLE_LIMIT = 20;

const deleteNoteTypeTemplateInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    templateName: noteTypeTemplateNameSchema,
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, report the permanent card impact without modifying Anki",
      ),
    expectedDesignHash: noteTypeDesignHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-design; required when dryRun is false and blocks stale writes",
      ),
    expectedCardCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Affected card count returned by the dry run; required when dryRun is false and blocks applying changed impact",
      ),
    expectedNotesLosingLastCardCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Count returned by the dry run for notes that would lose their last card; required when dryRun is false",
      ),
    confirmCardDeletion: z
      .boolean()
      .default(false)
      .describe(
        "Must be true when dryRun is false to confirm permanent deletion of generated cards and their review history",
      ),
    confirmNoteDeletion: z
      .boolean()
      .default(false)
      .describe(
        "Must be true when affected notes would lose their last card and dryRun is false",
      ),
  })
  .superRefine(
    (
      {
        dryRun,
        expectedDesignHash,
        expectedCardCount,
        expectedNotesLosingLastCardCount,
        confirmCardDeletion,
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
      if (expectedCardCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedCardCount"],
          message:
            "expectedCardCount is required when dryRun is false",
        });
      }
      if (expectedNotesLosingLastCardCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedNotesLosingLastCardCount"],
          message:
            "expectedNotesLosingLastCardCount is required when dryRun is false",
        });
      }
      if (!confirmCardDeletion) {
        context.addIssue({
          code: "custom",
          path: ["confirmCardDeletion"],
          message:
            "confirmCardDeletion must be true when dryRun is false",
        });
      }
    },
  );

type DeleteNoteTypeTemplateInput = z.infer<
  typeof deleteNoteTypeTemplateInputSchema
>;

export const deleteNoteTypeTemplateConfig = {
  title: "Delete note type template",
  description:
    "Permanently deletes one card template and every card generated from it. Reports notes that may lose their last card and requires explicit impact confirmation.",
  inputSchema: deleteNoteTypeTemplateInputSchema,
  outputSchema: noteTypeTemplateMutationResultSchema.extend({
    deletedTemplate: z
      .object({
        name: z.string(),
        order: z.number().int().nonnegative(),
        front: z.string(),
        back: z.string(),
      })
      .nullable(),
    impact: z.object({
      cardCount: z.number().int().nonnegative(),
      affectedNoteCount: z.number().int().nonnegative(),
      notesLosingLastCardCount: z.number().int().nonnegative(),
      sampleCardIds: z.array(z.number().int().positive()),
      sampleAffectedNoteIds: z.array(z.number().int().positive()),
      sampleNoteIdsLosingLastCard: z.array(
        z.number().int().positive(),
      ),
      sampleTruncated: z.boolean(),
    }),
    cardDeletionConfirmed: z.boolean(),
    noteDeletionConfirmed: z.boolean(),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Previews or permanently removes a template and its generated cards. */
export async function deleteNoteTypeTemplate({
  modelName,
  templateName,
  dryRun,
  expectedDesignHash,
  expectedCardCount,
  expectedNotesLosingLastCardCount,
  confirmCardDeletion,
  confirmNoteDeletion,
}: DeleteNoteTypeTemplateInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const existing = findNoteTypeTemplate(current.templates, templateName);
  const [cardIds, otherCardIds] =
    existing === undefined
      ? [[], []]
      : await Promise.all([
          findAnkiCards(
            buildTemplateCardsSearchQuery(modelName, templateName),
          ),
          findAnkiCards(
            buildOtherTemplateCardsSearchQuery(
              modelName,
              templateName,
            ),
          ),
        ]);
  const [affectedNoteIds, notesWithOtherCards] = await Promise.all([
    getAnkiNoteIdsForCards(cardIds),
    getAnkiNoteIdsForCards(otherCardIds),
  ]);
  const notesWithOtherCardsSet = new Set(notesWithOtherCards);
  const noteIdsLosingLastCard = affectedNoteIds.filter(
    (noteId) => !notesWithOtherCardsSet.has(noteId),
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
      path: "templateName",
      message: `Card template "${templateName}" was not found.`,
    });
  }
  if (current.templates.length === 1 && existing !== undefined) {
    issues.push({
      severity: "error",
      code: "cannot_delete_last_template",
      path: "templateName",
      message: "A note type must retain at least one card template.",
    });
  }
  if (
    expectedCardCount !== undefined &&
    expectedCardCount !== cardIds.length
  ) {
    issues.push({
      severity: "error",
      code: "template_delete_impact_changed",
      path: "expectedCardCount",
      message: `The template now has ${cardIds.length} cards instead of the expected ${expectedCardCount}. Run the dry run again.`,
    });
  }
  if (
    expectedNotesLosingLastCardCount !== undefined &&
    expectedNotesLosingLastCardCount !== noteIdsLosingLastCard.length
  ) {
    issues.push({
      severity: "error",
      code: "template_delete_note_impact_changed",
      path: "expectedNotesLosingLastCardCount",
      message: `${noteIdsLosingLastCard.length} notes would now lose their last card instead of the expected ${expectedNotesLosingLastCardCount}. Run the dry run again.`,
    });
  }
  if (
    !dryRun &&
    noteIdsLosingLastCard.length > 0 &&
    !confirmNoteDeletion
  ) {
    issues.push({
      severity: "error",
      code: "note_deletion_not_confirmed",
      path: "confirmNoteDeletion",
      message:
        "confirmNoteDeletion must be true because some notes may be deleted after losing their last card.",
    });
  }
  if (cardIds.length > 0) {
    issues.push({
      severity: "warning",
      code: "cards_will_be_deleted",
      path: "templateName",
      message: `Deleting this template permanently deletes ${cardIds.length} generated card${cardIds.length === 1 ? "" : "s"} and their review history.`,
    });
  }
  if (noteIdsLosingLastCard.length > 0) {
    issues.push({
      severity: "warning",
      code: "notes_may_be_deleted",
      path: "templateName",
      message: `${noteIdsLosingLastCard.length} note${noteIdsLosingLastCard.length === 1 ? "" : "s"} would lose their last card and may also be deleted by Anki.`,
    });
  }

  const canBuildProposal =
    existing !== undefined && current.templates.length > 1;
  const proposedTemplates = canBuildProposal
    ? normalizeTemplateOrders(
        current.templates.filter(({ name }) => name !== templateName),
      )
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
    deletedTemplate: existing ?? null,
    impact: {
      cardCount: cardIds.length,
      affectedNoteCount: affectedNoteIds.length,
      notesLosingLastCardCount: noteIdsLosingLastCard.length,
      sampleCardIds: cardIds.slice(0, IMPACT_SAMPLE_LIMIT),
      sampleAffectedNoteIds: affectedNoteIds.slice(
        0,
        IMPACT_SAMPLE_LIMIT,
      ),
      sampleNoteIdsLosingLastCard: noteIdsLosingLastCard.slice(
        0,
        IMPACT_SAMPLE_LIMIT,
      ),
      sampleTruncated:
        cardIds.length > IMPACT_SAMPLE_LIMIT ||
        affectedNoteIds.length > IMPACT_SAMPLE_LIMIT ||
        noteIdsLosingLastCard.length > IMPACT_SAMPLE_LIMIT,
    },
    cardDeletionConfirmed: confirmCardDeletion,
    noteDeletionConfirmed: confirmNoteDeletion,
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Deleted no card template from "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run found ${cardIds.length} card${cardIds.length === 1 ? "" : "s"} that would be permanently deleted with template "${templateName}"; ${noteIdsLosingLastCard.length} note${noteIdsLosingLastCard.length === 1 ? "" : "s"} would lose their last card, and Anki was not changed.`,
      result,
    );
  }

  await removeAnkiNoteTypeTemplate(modelName, templateName);
  const updated = await loadNoteTypeDesign(modelName);

  if (!hasSameTemplateDesign(updated.templates, proposedTemplates)) {
    throw new Error(
      `Anki returned an unexpected template design after deleting "${templateName}"`,
    );
  }

  return createToolResult(
    `Permanently deleted card template "${templateName}" and ${cardIds.length} generated card${cardIds.length === 1 ? "" : "s"} from note type "${modelName}".`,
    {
      ...result,
      applied: true,
      afterDesignHash: updated.designHash,
      templates: updated.templates,
    },
  );
}
