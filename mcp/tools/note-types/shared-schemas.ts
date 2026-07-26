import { z } from "zod";

export const NOTE_TYPE_CONTENT_LIMIT = 200_000;

export const noteTypeIdSchema = z.number().int().positive();

export const noteTypeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    'Anki note type name. AnkiConnect calls note types "models" in its API.',
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
});

export const noteTypeDesignHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("SHA-256 hash of the current CSS and card templates");

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
