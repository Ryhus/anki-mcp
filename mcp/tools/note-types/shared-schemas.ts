import { z } from "zod";

export const NOTE_TYPE_CONTENT_LIMIT = 200_000;

export const ANKI_SPECIAL_FIELD_NAMES = [
  "Card",
  "CardFlag",
  "CardID",
  "Deck",
  "FrontSide",
  "Subdeck",
  "Tags",
  "Type",
] as const;

const ankiSpecialFieldNameSet = new Set<string>(
  ANKI_SPECIAL_FIELD_NAMES.map((name) => name.toLowerCase()),
);

export const noteTypeIdSchema = z.number().int().positive();

export const noteTypeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    'Anki note type name. AnkiConnect calls note types "models" in its API.',
  );

export const noteTypeFieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("Existing Anki note-type field name");

export const newNoteTypeFieldNameSchema = noteTypeFieldNameSchema
  .refine(
    (name) => !ankiSpecialFieldNameSet.has(name.toLowerCase()),
    {
      message: `Field name cannot be an Anki special field: ${ANKI_SPECIAL_FIELD_NAMES.join(", ")}`,
    },
  )
  .describe(
    "New field name. Anki special field names such as Tags, Type, Deck, Card, and FrontSide are not allowed.",
  );

export const noteTypeSummarySchema = z.object({
  id: noteTypeIdSchema.describe("Anki note type/model ID"),
  name: z.string().describe("Anki note type/model name"),
});

export const noteTypeFieldSchema = z.object({
  name: z.string(),
  order: z.number().int().nonnegative(),
});

export const noteTypeCardTemplateSchema = z.object({
  name: z.string(),
  questionFields: z.array(z.string()),
  answerFields: z.array(z.string()),
});

export const noteTypeDetailsSchema = noteTypeSummarySchema.extend({
  fields: z.array(noteTypeFieldSchema),
  cardTemplates: z.array(noteTypeCardTemplateSchema),
  schemaHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("SHA-256 hash of the ordered note-type field names"),
});

export const noteTypeSchemaHashSchema =
  noteTypeDetailsSchema.shape.schemaHash;

export const noteTypeDesignHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("SHA-256 hash of the current CSS and card templates");

export const noteTypeTemplateNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("Anki card template name");

export const noteTypeTemplateHtmlSchema = z
  .string()
  .min(1)
  .max(NOTE_TYPE_CONTENT_LIMIT);

export const noteTypeTemplateDesignSchema = z.object({
  name: z.string(),
  order: z.number().int().nonnegative(),
  front: z.string(),
  back: z.string(),
});

export const noteTypeDesignSchema = z.object({
  noteType: noteTypeSummarySchema.extend({
    fields: z.array(noteTypeFieldSchema),
  }),
  css: z.string(),
  templates: z.array(noteTypeTemplateDesignSchema),
  designHash: noteTypeDesignHashSchema,
  scopeWarning: z.string(),
});

export const designValidationIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  path: z.string(),
  message: z.string(),
});

export const designValidationSchema = z.object({
  valid: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  issues: z.array(designValidationIssueSchema),
});

export const noteTypeFieldMutationResultSchema = z.object({
  modelName: z.string(),
  dryRun: z.boolean(),
  applied: z.boolean(),
  changed: z.boolean(),
  beforeSchemaHash: noteTypeSchemaHashSchema,
  afterSchemaHash: noteTypeSchemaHashSchema,
  previousFields: z.array(noteTypeFieldSchema),
  fields: z.array(noteTypeFieldSchema),
  validation: designValidationSchema,
  scopeWarning: z.string(),
});

export const noteTypeTemplateMutationResultSchema = z.object({
  modelName: z.string(),
  dryRun: z.boolean(),
  applied: z.boolean(),
  changed: z.boolean(),
  beforeDesignHash: noteTypeDesignHashSchema,
  afterDesignHash: noteTypeDesignHashSchema,
  previousTemplates: z.array(noteTypeTemplateDesignSchema),
  templates: z.array(noteTypeTemplateDesignSchema),
  validation: designValidationSchema,
  scopeWarning: z.string(),
});

export type NoteTypeSummary = z.infer<typeof noteTypeSummarySchema>;
export type NoteTypeDetails = z.infer<typeof noteTypeDetailsSchema>;
export type NoteTypeTemplateDesign = z.infer<
  typeof noteTypeTemplateDesignSchema
>;
export type NoteTypeDesign = z.infer<typeof noteTypeDesignSchema>;
export type DesignValidationIssue = z.infer<
  typeof designValidationIssueSchema
>;
export type DesignValidation = z.infer<typeof designValidationSchema>;
