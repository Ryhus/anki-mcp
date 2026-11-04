import type { CallToolResult } from "@modelcontextprotocol/server";
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
  noteTypeDesignSchema,
  noteTypeNameSchema,
  type NoteTypeDesign,
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
    "Validates and replaces the CSS shared by every card of one note type. Defaults to dry-run mode; applying requires expectedDesignHash. Reports applied only after reading back the exact CSS and confirming the Note Type identity and unchanged templates. A write/readback error may follow an applied change; do not blindly retry.",
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

/** Validates the current revision, writes once, and verifies the saved design. */
export async function updateNoteTypeStyling({
  modelName,
  css,
  dryRun,
  expectedDesignHash,
}: UpdateNoteTypeStylingInput): Promise<CallToolResult> {
  const current = await loadStylingDesign(modelName);
  const revisionValidation =
    (expectedDesignHash === undefined && dryRun) ||
    expectedDesignHash === current.designHash
      ? createDesignValidation([])
      : createDesignValidation([
          {
            severity: "error",
            code: expectedDesignHash === undefined ? "design_hash_required" : "design_changed",
            path: "expectedDesignHash",
            message:
              expectedDesignHash === undefined
                ? "Applying requires the current expectedDesignHash. Read or preview the design before applying."
                : "The note type design changed after it was read. Load it again before applying an update.",
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

  try {
    await updateAnkiNoteTypeStyling(modelName, css);
  } catch (error) {
    throw new Error(
      `Could not confirm the CSS update for note type "${modelName}". CSS may already have changed. No automatic retry or rollback was performed; inspect Anki before retrying. ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let updated: NoteTypeDesign;
  try {
    updated = await loadStylingDesign(modelName);
    if (updated.noteType.id !== current.noteType.id) {
      throw new Error("The Note Type identity changed during the CSS update");
    }
    if (updated.css !== css || updated.designHash !== afterHash) {
      throw new Error("The saved CSS or Card Templates did not match the expected design");
    }
  } catch (error) {
    throw new Error(
      `Anki acknowledged the CSS update for note type "${modelName}", but verification failed. CSS may already have changed. No automatic retry or rollback was performed; inspect Anki before retrying. ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return createToolResult(
    `Updated and verified the shared CSS for note type "${modelName}". ${current.scopeWarning}`,
    { ...result, applied: true, afterHash: updated.designHash },
  );
}

/** Rejects incomplete backend data without echoing CSS/HTML in error messages. */
async function loadStylingDesign(modelName: string): Promise<NoteTypeDesign> {
  const parsed = noteTypeDesignSchema.safeParse(await loadNoteTypeDesign(modelName));
  if (!parsed.success) {
    throw new Error("AnkiConnect returned incomplete or invalid Note Type design data");
  }
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown CSS update failure";
}
