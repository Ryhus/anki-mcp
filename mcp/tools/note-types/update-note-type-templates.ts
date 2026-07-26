import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { updateAnkiNoteTypeTemplates } from "../../../anki-api/note-types/note-type-client.js";
import type { AnkiNoteTypeTemplateUpdates } from "../../../anki-api/note-types/note-type-types.js";
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
} from "./note-type-design-utils.js";
import {
  createDesignValidation,
} from "./design-validation.js";
import { validateTemplateSide } from "./template-validator.js";
import {
  type DesignValidationIssue,
  designValidationSchema,
  NOTE_TYPE_CONTENT_LIMIT,
  noteTypeDesignHashSchema,
  noteTypeNameSchema,
} from "./shared-schemas.js";

const templateHtmlSchema = z
  .string()
  .min(1)
  .max(NOTE_TYPE_CONTENT_LIMIT);

const templateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    front: templateHtmlSchema
      .optional()
      .describe("Complete replacement HTML for the front side"),
    back: templateHtmlSchema
      .optional()
      .describe("Complete replacement HTML for the back side"),
  })
  .refine(
    ({ front, back }) => front !== undefined || back !== undefined,
    { message: "Each template update must provide front or back HTML" },
  );

const updateNoteTypeTemplatesInputSchema = z
  .object({
    modelName: noteTypeNameSchema,
    templates: z
      .array(templateUpdateSchema)
      .min(1)
      .max(50)
      .refine(
        (templates) =>
          new Set(templates.map(({ name }) => name)).size ===
          templates.length,
        { message: "Each template name can appear only once" },
      ),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        "When true, validate and report the proposed changes without modifying Anki",
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

type UpdateNoteTypeTemplatesInput = z.infer<
  typeof updateNoteTypeTemplatesInputSchema
>;

const templateChangeSchema = z.object({
  name: z.string(),
  changedSides: z.array(z.enum(["front", "back"])),
  previous: z.object({
    front: z.string(),
    back: z.string(),
  }),
  proposed: z.object({
    front: z.string(),
    back: z.string(),
  }),
});

type TemplateChange = z.infer<typeof templateChangeSchema>;

export const updateNoteTypeTemplatesConfig = {
  title: "Update note type templates",
  description:
    "Validates and replaces selected front/back HTML templates for one note type. Defaults to dry-run mode and applies all requested sides in one Anki undo step.",
  inputSchema: updateNoteTypeTemplatesInputSchema,
  outputSchema: z.object({
    modelName: z.string(),
    dryRun: z.boolean(),
    applied: z.boolean(),
    changed: z.boolean(),
    beforeHash: noteTypeDesignHashSchema,
    afterHash: noteTypeDesignHashSchema,
    changes: z.array(templateChangeSchema),
    validation: designValidationSchema,
    scopeWarning: z.string(),
  }),
  annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
};

/** Validates a batch of HTML template patches before any side is changed. */
export async function updateNoteTypeTemplates({
  modelName,
  templates,
  dryRun,
  expectedDesignHash,
}: UpdateNoteTypeTemplatesInput): Promise<CallToolResult> {
  const current = await loadNoteTypeDesign(modelName);
  const currentTemplates = new Map(
    current.templates.map((template) => [template.name, template]),
  );
  const fieldNames = current.noteType.fields.map(({ name }) => name);
  const issues: DesignValidationIssue[] = [];
  const changes: TemplateChange[] = [];
  const proposedTemplates = current.templates.map((template) => ({
    ...template,
  }));
  const ankiUpdates: AnkiNoteTypeTemplateUpdates = {};

  if (
    expectedDesignHash !== undefined &&
    expectedDesignHash !== current.designHash
  ) {
    issues.push({
      severity: "error" as const,
      code: "design_changed",
      path: "expectedDesignHash",
      message:
        "The note type design changed after it was read. Load it again before applying an update.",
    });
  }

  for (const [updateIndex, update] of templates.entries()) {
    const existing = currentTemplates.get(update.name);

    if (existing === undefined) {
      issues.push({
        severity: "error" as const,
        code: "template_not_found",
        path: `templates[${updateIndex}].name`,
        message: `Card template not found: ${update.name}`,
      });
      continue;
    }

    const proposed = {
      front: update.front ?? existing.front,
      back: update.back ?? existing.back,
    };
    const changedSides: Array<"front" | "back"> = [];
    const remoteUpdate: {
      Front?: string;
      Back?: string;
    } = {};

    if (update.front !== undefined) {
      const validation = validateTemplateSide({
        html: update.front,
        fieldNames,
        path: `templates[${updateIndex}].front`,
        requireFieldReference: true,
      });
      issues.push(...validation.issues);

      if (update.front !== existing.front) {
        changedSides.push("front");
        remoteUpdate.Front = update.front;
      }
    }

    if (update.back !== undefined) {
      const validation = validateTemplateSide({
        html: update.back,
        fieldNames,
        path: `templates[${updateIndex}].back`,
        requireFieldReference: false,
      });
      issues.push(...validation.issues);

      if (update.back !== existing.back) {
        changedSides.push("back");
        remoteUpdate.Back = update.back;
      }
    }

    changes.push({
      name: existing.name,
      changedSides,
      previous: {
        front: existing.front,
        back: existing.back,
      },
      proposed,
    });

    const proposedTemplate = proposedTemplates[existing.order];
    if (proposedTemplate === undefined) {
      throw new Error(
        `Template order is invalid for note type "${modelName}"`,
      );
    }
    proposedTemplate.front = proposed.front;
    proposedTemplate.back = proposed.back;

    if (changedSides.length > 0) {
      ankiUpdates[existing.name] = remoteUpdate;
    }
  }

  const validation = createDesignValidation(issues);
  const changedTemplateCount = Object.keys(ankiUpdates).length;
  const changed = changedTemplateCount > 0;
  const result = {
    modelName,
    dryRun,
    applied: false,
    changed,
    beforeHash: current.designHash,
    afterHash: calculateNoteTypeDesignHash(
      current.css,
      proposedTemplates,
    ),
    changes,
    validation,
    scopeWarning: current.scopeWarning,
  };

  if (!validation.valid) {
    return createToolResult(
      `Applied no template change to "${modelName}" because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (!changed) {
    return createToolResult(
      `The selected templates for note type "${modelName}" already match the requested HTML.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for ${changedTemplateCount} changed template${changedTemplateCount === 1 ? "" : "s"} in note type "${modelName}" with ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed. ${current.scopeWarning}`,
      result,
    );
  }

  await updateAnkiNoteTypeTemplates(modelName, ankiUpdates);

  return createToolResult(
    `Updated ${changedTemplateCount} template${changedTemplateCount === 1 ? "" : "s"} for note type "${modelName}". ${current.scopeWarning} The update can be reverted immediately with Anki Undo.`,
    { ...result, applied: true },
  );
}
