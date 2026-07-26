import { z } from "zod";

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

export type NoteTypeSummary = z.infer<typeof noteTypeSummarySchema>;
export type NoteTypeDetails = z.infer<typeof noteTypeDetailsSchema>;
