import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { updateAnkiNoteTypeStyling } from "../../../anki-api/note-types/note-type-client.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
} from "./note-type-design-utils.js";
import {
  combineValidations,
  createDesignValidation,
} from "./design-validation.js";
import { validateCss } from "./css-validator.js";
import {
  designValidationSchema,
  NOTE_TYPE_CONTENT_LIMIT,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
} from "./shared-schemas.js";

const updateNoteTypeStylingInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    css: z
      .string()
      .max(NOTE_TYPE_CONTENT_LIMIT)
      .describe("Complete replacement CSS for the note type"),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and report the proposed change without modifying Anki",
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

type UpdateNoteTypeStylingInput = z.infer<
  typeof updateNoteTypeStylingInputSchema
>;

export const updateNoteTypeStylingConfig = {
  title: "Update note type styling",
  description:
    "Validates and replaces the CSS shared by every card of one note type. Defaults to dry-run mode; set dryRun to false only after reviewing the validation result.",
  inputSchema: updateNoteTypeStylingInputSchema,
  outputSchema: z.object({
    modelName: z.string(),
    dryRun: z.boolean(),
    applied: z.boolean(),
    changed: z.boolean(),
    beforeHash: noteTypeDesignHashSchema,
    afterHash: noteTypeDesignHashSchema,
    previousCss: z.string(),
    css: z.string(),
    validation: designValidationSchema,
    scopeWarning: z.string(),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Validates CSS and replaces it only when the requested revision is current. */
export async function updateNoteTypeStyling({
  modelName,
  css,
  dryRun,
  expectedDesignHash,
}: UpdateNoteTypeStylingInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const revisionValidation =
    expectedDesignHash === undefined ||
    expectedDesignHash === current.designHash
      ? createDesignValidation([])
      : createDesignValidation([
          {
            severity: "error",
            code: "design_changed",
            path: "expectedDesignHash",
            message:
              "The note type design changed after it was read. Load it again before applying an update.",
          },
        ]);
  const validation = combineValidations([
    validateCss(css),
    revisionValidation,
  ]);
  const changed = css !== current.css;
  const afterHash = calculateNoteTypeDesignHash(
    css,
    current.templates,
  );
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed,
    beforeHash: current.designHash,
    afterHash,
    previousCss: current.css,
    css,
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Applied no CSS change to "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (!changed) {
    return createToolResult(
      `The CSS for note type "${modelName}" already matches the requested value.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for note type "${modelName}" with ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed. ${current.scopeWarning}`,
      result,
    );
  }

  await updateAnkiNoteTypeStyling(modelName, css);

  return createToolResult(
    `Updated the shared CSS for note type "${modelName}". ${current.scopeWarning} The change can be reverted immediately with Anki Undo.`,
    { ...result, applied: true },
  );
}
