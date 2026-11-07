import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import {
  createAnkiNoteType,
  getAnkiNoteTypeNameMap,
} from "../../../anki-api/note-types/note-type-client.js";
import { createManagedNoteType } from "../../../anki-api/note-types/note-type-management-client.js";
import { openV1Adapter } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { getV1NameMap, getV1NoteTypeDesignWithSortField } from "../../../anki-api/v1/anki-v1-collection-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import { buildNoteTypeCloneDefinition } from "./note-type-clone-utils.js";
import { loadNoteTypeDesign, normalizeV1NoteTypeDesign } from "./note-type-design-utils.js";
import { hasSameFieldOrder } from "./note-type-schema-utils.js";
import {
  type DesignValidationIssue,
  designValidationSchema,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
  noteTypeSummarySchema,
} from "./shared-schemas.js";

const cloneHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const cloneNoteTypeInputSchema = z
  .object({
    sourceModelName: noteTypeNameSchema.describe(
      "Existing note type whose ordered fields, templates, CSS, and v1 sort field should be copied",
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
        "Source design hash required for legacy apply; v1 apply requires expectedCloneHash.",
      ),
    expectedCloneHash: cloneHashSchema.optional()
      .describe("Hash returned by the reviewed clone preview; required for apply in v1."),
  })
  .superRefine(
    (
      {
        sourceModelName,
        targetModelName,
        dryRun,
        expectedSourceDesignHash,
        expectedCloneHash,
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

      if (!dryRun && expectedSourceDesignHash === undefined && expectedCloneHash === undefined) {
        context.addIssue({
          code: "custom",
          path: ["expectedSourceDesignHash"],
          message:
            "A reviewed clone hash (v1) or source design hash (legacy) is required when dryRun is false.",
        });
      }
    },
  );

type CloneNoteTypeInput = z.infer<typeof cloneNoteTypeInputSchema>;

const cloneSummarySchema = z.object({
  fieldNames: z.array(z.string()),
  sortField: z.string().nullable().describe("Source sort field preserved by v1; null in legacy mode."),
  templateNames: z.array(z.string()),
  cssLength: z.number().int().nonnegative(),
});

export const cloneNoteTypeConfig = {
  title: "Clone note type",
  description:
    "Creates an independent note type with the source's ordered fields, card template HTML, and shared CSS. In AnkiConnect v1 it preserves the Browser sort field and requires the reviewed clone hash before applying. Does not copy notes or cards.",
  inputSchema: cloneNoteTypeInputSchema,
  outputSchema: z.object({
    sourceModelName: z.string(),
    targetModelName: z.string(),
    dryRun: z.boolean(),
    created: z.boolean(),
    createdNoteType: noteTypeSummarySchema.nullable(),
    sourceDesignHash: noteTypeDesignHashSchema,
    cloneHash: cloneHashSchema.nullable(),
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
  expectedCloneHash,
}: CloneNoteTypeInput): Promise<CallToolResult> {
  const ctx = useAnkiV1("noteTypes.create") ? await openV1Adapter({}) : null;
  const nativeSource = ctx === null ? null : await getV1NoteTypeDesignWithSortField(sourceModelName, ctx.session);
  const source = nativeSource === null ? await loadNoteTypeDesign(sourceModelName) : normalizeV1NoteTypeDesign(nativeSource);
  const noteTypes = ctx === null ? await getAnkiNoteTypeNameMap() : await getV1NameMap("noteTypes.list", ctx.session, ctx.options);
  const definition = buildNoteTypeCloneDefinition(
    source,
    isClozeOverride,
  );
  const sortField = nativeSource?.sortField ?? null;
  const cloneHash = ctx === null ? null : createHash("sha256").update(JSON.stringify([
    "clone-note-type", 1, ctx.session, source.noteType.id, source.noteType.name, targetModelName,
    definition.isCloze, source.designHash, definition.inOrderFields, sortField,
  ])).digest("hex");
  const issues: DesignValidationIssue[] = [];

  if (Object.hasOwn(noteTypes, targetModelName)) {
    issues.push({
      severity: "error",
      code: "target_note_type_exists",
      path: "targetModelName",
      message: `A note type named "${targetModelName}" already exists.`,
    });
  }

  if (!dryRun && ctx !== null && expectedCloneHash === undefined) {
    issues.push({
      severity: "error", code: "clone_hash_required", path: "expectedCloneHash",
      message: "Applying a v1 clone requires expectedCloneHash from a fresh preview.",
    });
  }
  if (!dryRun && ctx === null && expectedSourceDesignHash === undefined) {
    issues.push({
      severity: "error", code: "source_design_hash_required", path: "expectedSourceDesignHash",
      message: "Applying a legacy clone requires expectedSourceDesignHash.",
    });
  }
  if (expectedCloneHash !== undefined && expectedCloneHash !== cloneHash) {
    issues.push({
      severity: "error", code: "clone_impact_changed", path: "expectedCloneHash",
      message: "The reviewed clone, source fields, sort field, or collection session changed. Preview the clone again.",
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
    cloneHash,
    isCloze: definition.isCloze,
    isClozeDetected: definition.isClozeDetected,
    cloneSummary: {
      fieldNames: definition.inOrderFields,
      sortField,
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

  const definitionToCreate = {
    modelName: targetModelName,
    inOrderFields: definition.inOrderFields,
    cardTemplates: definition.cardTemplates,
    css: definition.css,
    isCloze: definition.isCloze,
    ...(sortField === null ? {} : { sortField }),
  };
  let createdId: number | undefined;
  if (ctx === null) {
    await createAnkiNoteType(definitionToCreate);
    createdId = (await getAnkiNoteTypeNameMap())[targetModelName];
  } else {
    const created = await createManagedNoteType(ctx, definitionToCreate);
    createdId = created.id;
    try {
      const saved = await getV1NoteTypeDesignWithSortField(createdId, ctx.session);
      if (saved.name !== targetModelName || saved.sortField !== sortField ||
          !hasSameFieldOrder(saved.fields.map(({ name }) => name), definition.inOrderFields) ||
          normalizeV1NoteTypeDesign(saved).designHash !== source.designHash) {
        throw new Error("The saved field order, sort field, name, or design did not match.");
      }
    } catch (error) {
      throw new Error(
        `Anki may already have created "${targetModelName}", but readback did not verify the clone. Inspect Anki before retrying.`,
        { cause: error },
      );
    }
  }

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
