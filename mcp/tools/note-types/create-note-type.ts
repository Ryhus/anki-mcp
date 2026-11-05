import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { useAnkiV1 } from "../../../anki-api/anki-api-mode.js";
import { AnkiRequestError } from "../../../anki-api/anki-request-error.js";
import {
  createAnkiNoteType,
  getAnkiNoteTypeNameMap,
} from "../../../anki-api/note-types/note-type-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import {
  calculateNoteTypeDesignHash,
  loadNoteTypeDesign,
  NOTE_TYPE_SCOPE_WARNING,
} from "./note-type-design-utils.js";
import { validateNoteTypeDefinition } from "./note-type-definition-validator.js";
import {
  calculateNoteTypeSchemaHash,
  hasSameFieldOrder,
  loadNoteTypeSchema,
  toOrderedFields,
} from "./note-type-schema-utils.js";
import {
  designValidationSchema,
  type DesignValidationIssue,
  NOTE_TYPE_CONTENT_LIMIT,
  newNoteTypeFieldNameSchema,
  noteTypeDesignHashSchema,
  noteTypeFieldSchema,
  noteTypeNameSchema,
  noteTypeSchemaHashSchema,
  noteTypeSortFieldNameSchema,
  noteTypeSummarySchema,
  noteTypeTemplateDesignSchema,
} from "./shared-schemas.js";

export const DEFAULT_NOTE_TYPE_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

const createNoteTypeTemplateSchema = z.object({
  name: z.string().trim().min(1).max(500),
  front: z
    .string()
    .min(1)
    .max(NOTE_TYPE_CONTENT_LIMIT)
    .describe("Complete HTML for the front side"),
  back: z
    .string()
    .min(1)
    .max(NOTE_TYPE_CONTENT_LIMIT)
    .describe("Complete HTML for the back side"),
});

const createNoteTypeInputSchema = z.object({
  modelName: noteTypeNameSchema.describe(
    "Unique name for the new Anki note type",
  ),
  fields: z
    .array(newNoteTypeFieldNameSchema)
    .min(1)
    .max(100)
    .refine(
      (fields) =>
        new Set(fields.map((field) => field.toLowerCase())).size ===
        fields.length,
      { message: "Field names must be unique" },
    )
    .describe(
      "Field names in their desired order. The first field is used for duplicate checks.",
    ),
  sortField: noteTypeSortFieldNameSchema.optional()
    .describe("Exact name from fields. Requires AnkiConnect v1. Omit to use Anki's default first field."),
  templates: z
    .array(createNoteTypeTemplateSchema)
    .min(1)
    .max(50)
    .refine(
      (templates) =>
        new Set(templates.map(({ name }) => name.toLowerCase())).size ===
        templates.length,
      { message: "Card template names must be unique" },
    ),
  css: z
    .string()
    .max(NOTE_TYPE_CONTENT_LIMIT)
    .default(DEFAULT_NOTE_TYPE_CSS)
    .describe(
      "Shared CSS for every card generated from the note type",
    ),
  isCloze: z
    .boolean()
    .default(false)
    .describe("Whether to create an Anki Cloze note type"),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "When true, validate and preview the note type without creating it",
    ),
}).refine(({ fields, sortField }) => sortField === undefined || fields.includes(sortField), {
  path: ["sortField"], message: "The sort field must be an exact name from fields.",
});

type CreateNoteTypeInput = z.infer<typeof createNoteTypeInputSchema>;

export const createNoteTypeConfig = {
  title: "Create note type",
  description:
    "Creates a new Normal or Cloze note type from ordered fields, complete card templates, and shared CSS. Optionally selects its Browser sort field in AnkiConnect v1. Defaults to dry-run mode and does not create notes or cards.",
  inputSchema: createNoteTypeInputSchema,
  outputSchema: z.object({
    modelName: z.string(),
    dryRun: z.boolean(),
    created: z.boolean(),
    createdNoteType: noteTypeSummarySchema.nullable(),
    isCloze: z.boolean(),
    sortField: z.string().nullable().describe("Proposed or verified Browser sort field; null in legacy mode."),
    fields: z.array(noteTypeFieldSchema),
    templates: z.array(noteTypeTemplateDesignSchema),
    css: z.string(),
    schemaHash: noteTypeSchemaHashSchema,
    designHash: noteTypeDesignHashSchema,
    validation: designValidationSchema,
    scopeWarning: z.string(),
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/** Validates and previews or creates a complete independent note type. */
export async function createNoteType({
  modelName,
  fields,
  sortField,
  templates,
  css,
  isCloze,
  dryRun,
}: CreateNoteTypeInput): Promise<CallToolResult> {
  const v1 = useAnkiV1("noteTypes.create");
  if (!v1 && sortField !== undefined) {
    throw new AnkiRequestError("configuration", "noteTypes.create", "Specifying sortField requires ANKI_API_MODE=v1.", false);
  }
  const resolvedSortField = v1 ? sortField ?? fields[0]! : null;
  const noteTypes = await getAnkiNoteTypeNameMap();
  const definitionValidation = validateNoteTypeDefinition({
    fieldNames: fields,
    templates,
    css,
    isCloze,
  });
  const issues: DesignValidationIssue[] = [
    ...definitionValidation.issues,
  ];

  if (Object.hasOwn(noteTypes, modelName)) {
    issues.push({
      severity: "error",
      code: "note_type_already_exists",
      path: "modelName",
      message: `A note type named "${modelName}" already exists.`,
    });
  }

  const validation = createDesignValidation(issues);
  const orderedFields = toOrderedFields(fields);
  const orderedTemplates = templates.map(
    ({ name, front, back }, order) => ({
      name,
      order,
      front,
      back,
    }),
  );
  const schemaHash = calculateNoteTypeSchemaHash(fields);
  const designHash = calculateNoteTypeDesignHash(
    css,
    orderedTemplates,
  );
  const result = {
    modelName,
    dryRun,
    created: false,
    createdNoteType: null,
    isCloze,
    sortField: resolvedSortField,
    fields: orderedFields,
    templates: orderedTemplates,
    css,
    schemaHash,
    designHash,
    validation,
    scopeWarning: NOTE_TYPE_SCOPE_WARNING,
  };

  if (!validation.valid) {
    return createToolResult(
      `Created no note type because validation found ${validation.errorCount} error${validation.errorCount === 1 ? "" : "s"}.`,
      result,
    );
  }

  if (dryRun) {
    return createToolResult(
      `Dry run passed for creating ${isCloze ? "Cloze" : "Normal"} note type "${modelName}" with ${fields.length} field${fields.length === 1 ? "" : "s"}, ${templates.length} card template${templates.length === 1 ? "" : "s"}, and ${validation.warningCount} warning${validation.warningCount === 1 ? "" : "s"}; Anki was not changed.`,
      result,
    );
  }

  const acknowledged = await createAnkiNoteType({
    modelName,
    inOrderFields: fields,
    cardTemplates: templates.map(({ name, front, back }) => ({
      Name: name,
      Front: front,
      Back: back,
    })),
    css,
    isCloze,
    ...(sortField === undefined ? {} : { sortField }),
  });

  const [createdSchema, createdDesign] = await Promise.all([
    loadNoteTypeSchema(modelName), loadNoteTypeDesign(modelName),
  ]).catch((error: unknown) => {
    throw new Error(`Anki may already have created "${modelName}"; readback failed. Inspect Anki before retrying.`, { cause: error });
  });

  if ((v1 && (createdSchema.id !== acknowledged.id || createdDesign.noteType.id !== acknowledged.id ||
      createdSchema.sortField !== resolvedSortField)) ||
      !hasSameFieldOrder(createdSchema.fields.map(({ name }) => name), fields) || createdDesign.designHash !== designHash) {
    throw new Error(
      `Anki may already have created "${modelName}", but the saved ID, field order, sort field, or design did not match. Inspect Anki before retrying.`,
    );
  }

  return createToolResult(
    `Created ${isCloze ? "Cloze" : "Normal"} note type "${modelName}" with ${fields.length} field${fields.length === 1 ? "" : "s"} and ${templates.length} card template${templates.length === 1 ? "" : "s"}. No notes or cards were created.`,
    {
      ...result,
      created: true,
      createdNoteType: {
        id: createdSchema.id,
        name: createdSchema.name,
      },
      fields: createdSchema.fields,
      sortField: createdSchema.sortField,
      templates: createdDesign.templates,
      css: createdDesign.css,
      schemaHash: createdSchema.schemaHash,
      designHash: createdDesign.designHash,
    },
  );
}
