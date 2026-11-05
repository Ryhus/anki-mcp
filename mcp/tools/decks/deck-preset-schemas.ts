import { z } from "zod";
import { presetSettingValueSchema } from "../../../anki-api/decks/deck-preset-client.js";
import { deckIdSchema } from "./shared-schemas.js";

export const presetIdSchema = z.number().int().positive();
export const presetNameSchema = z.string().trim().min(1).max(200)
  .refine((name) => !/[\u0000-\u001f\u007f]/u.test(name), "Preset name cannot include control characters")
  .transform((name) => name.normalize("NFC"));
export const presetSummarySchema = z.object({ id: presetIdSchema, name: z.string() });
export const presetDetailsSchema = presetSummarySchema.extend({
  settings: z.record(z.string(), presetSettingValueSchema), modifiedAt: z.iso.datetime(),
});
export const presetDeckSchema = z.object({ id: deckIdSchema, name: z.string() });
export const presetImpactLimit = 100;

const dayLimit = z.number().int().min(0).max(9_999);
const steps = z.array(z.number().positive().max(1_440)).max(20);
export const presetPatchSchema = z.strictObject({
  newPerDay: dayLimit.optional(),
  reviewsPerDay: dayLimit.optional(),
  learnStepsMinutes: steps.optional(),
  relearnStepsMinutes: steps.optional(),
  maximumIntervalDays: z.number().int().min(1).max(36_500).optional(),
  desiredRetention: z.number().min(0.70).max(0.99).optional().describe("FSRS target as a fraction, for example 0.90"),
  buryNew: z.boolean().optional(),
  buryReviews: z.boolean().optional(),
  buryDayLearning: z.boolean().optional(),
}).refine((settings) => Object.values(settings).some((value) => value !== undefined), "Supply at least one supported setting");

export const presetImpactHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const presetPreviewInput = {
  dryRun: z.boolean().default(true),
  expectedImpactHash: presetImpactHashSchema.optional(),
};
export const presetPreviewOutput = {
  dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(),
  impactHash: presetImpactHashSchema.nullable(),
  blockers: z.array(z.string()), warnings: z.array(z.string()),
};
export const settingChangeSchema = z.object({
  key: z.string(), before: presetSettingValueSchema.nullable(), after: presetSettingValueSchema,
});
