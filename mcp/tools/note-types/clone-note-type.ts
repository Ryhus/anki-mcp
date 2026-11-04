import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createAnkiNoteType,
  getAnkiNoteTypeNameMap,
} from "../../../anki-api/note-types/note-type-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import { buildNoteTypeCloneDefinition } from "./note-type-clone-utils.js";
import { loadNoteTypeDesign } from "./note-type-design-utils.js";
import {
  type DesignValidationIssue,
  designValidationSchema,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
  noteTypeSummarySchema,
} from "./shared-schemas.js";

const cloneNoteTypeInputSchema = z
  .object({
    sourceModelName: noteTypeNameSchema.describe(
      "Existing note type whose ordered fields, templates, and CSS should be copied",
    ),
    targetModelName: noteTypeNameSchema.describe(
      "Unique name for the new independent note type",
    ),
    isCloze: z
      .boolean()
      .optional()
      .describe(
        "Optional normal/Cloze override. By default the tool detects {{cloze:...}} filters in the source templates.",
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and preview the clone without creating a note type",
      ),
    expectedSourceDesignHash: noteTypeDesignHashSchema
      .optional()
      .describe(
        "Hash returned by get-note-type-design; required when dryRun is false and blocks cloning a stale design",
      ),
  })
  .superRefine(
    (
      {
        sourceModelName,
        targetModelName,
        dryRun,
        expectedSourceDesignHash,
      },
      context,
    ) => {
      if (sourceModelName === targetModelName) {
        context.addIssue({
          code: "custom",
          path: ["targetModelName"],
          message: "The target note type name must differ from the source",
        });
      }

      if (!dryRun && expectedSourceDesignHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedSourceDesignHash"],
          message:
            "expectedSourceDesignHash is required when dryRun is false",
        });
      }
    },
  );

type CloneNoteTypeInput = z.infer<typeof cloneNoteTypeInputSchema>;

const cloneSummarySchema = z.object({
  fieldNames: z.array(z.string()),
  templateNames: z.array(z.string()),
  cssLength: z.number().int().nonnegative(),
});

export const cloneNoteTypeConfig = {
  title: "Clone note type",
  description:
    "Safely creates an independent note type by copying ordered field names, card template HTML, and shared CSS from an existing note type. Defaults to dry-run mode and does not copy notes or cards.",
  inputSchema: cloneNoteTypeInputSchema,
  outputSchema: z.object({
    sourceModelName: z.string(),
    targetModelName: z.string(),
    dryRun: z.boolean(),
    created: z.boolean(),
    createdNoteType: noteTypeSummarySchema.nullable(),
    sourceDesignHash: noteTypeDesignHashSchema,
    isCloze: z.boolean(),
    isClozeDetected: z.boolean(),
    cloneSummary: cloneSummarySchema,
    validation: designValidationSchema,
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/**
 * Previews or creates an independent copy of a note type's editable design.
 */
export async function cloneNoteType({
  sourceModelName,
  targetModelName,
  isCloze: isClozeOverride,
  dryRun,
  expectedSourceDesignHash,
}: CloneNoteTypeInput): Promise<CallToolResult> {
  const source = await loadNoteTypeDesign(sourceModelName);
  const noteTypes = await getAnkiNoteTypeNameMap();
  const definition = buildNoteTypeCloneDefinition(
    source,
    isClozeOverride,
  );
  const issues: DesignValidationIssue[] = [];

  if (noteTypes[targetModelName] !== undefined) {
    issues.push({
      severity: "error",
      code: "target_note_type_exists",
      path: "targetModelName",
      message: `A note type named "${targetModelName}" already exists.`,
    });
  }

  if (
    expectedSourceDesignHash !== undefined &&
    expectedSourceDesignHash !== source.designHash
  ) {
    issues.push({
      severity: "error",
      code: "source_design_changed",
      path: "expectedSourceDesignHash",
      message:
        "The source note type design changed after it was read. Load it again before creating the clone.",
    });
  }

  if (isClozeOverride === false && definition.isClozeDetected) {
    issues.push({
      severity: "error",
      code: "cloze_template_requires_cloze_type",
      path: "isCloze",
      message:
        "The source templates contain a cloze filter and cannot be cloned as a normal note type.",
    });
  } else if (definition.isCloze && !definition.isClozeDetected) {
    issues.push({
      severity: "warning",
      code: "cloze_filter_not_detected",
      path: "isCloze",
      message:
        "The clone is configured as Cloze, but no {{cloze:...}} filter was detected in its templates.",
    });
  }

  const validation = createDesignValidation(issues);
  const result = {
    sourceModelName,
    targetModelName,
    dryRun,
    created: false,
    createdNoteType: null,
    sourceDesignHash: source.designHash,
    isCloze: definition.isCloze,
    isClozeDetected: definition.isClozeDetected,
    cloneSummary: {
      fieldNames: definition.inOrderFields,
      templateNames: definition.cardTemplates.map(({ Name }) => Name),
      cssLength: definition.css.length,
    },
    validation,
  };

  if (!validation.valid) {
    return createToolResult(
      `Created no note type because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for cloning "${sourceModelName}" as "${targetModelName}" with ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed.`,
      result,
    );
  }

  await createAnkiNoteType({
    modelName: targetModelName,
    inOrderFields: definition.inOrderFields,
    cardTemplates: definition.cardTemplates,
    css: definition.css,
    isCloze: definition.isCloze,
  });

  const createdId = (await getAnkiNoteTypeNameMap())[targetModelName];

  if (createdId === undefined) {
    throw new Error(
      `AnkiConnect did not return the created note type "${targetModelName}"`,
    );
  }

  return createToolResult(
    `Cloned note type "${sourceModelName}" as "${targetModelName}". No notes or cards were copied.`,
    {
      ...result,
      created: true,
      createdNoteType: {
        id: createdId,
        name: targetModelName,
      },
    },
  );
}
