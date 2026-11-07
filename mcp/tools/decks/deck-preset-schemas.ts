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
const reviewMix = z.enum(["mixed", "afterReviews", "beforeReviews"]);
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
  newGatherOrder: z.enum([
    "deck", "deckThenRandomNotes", "lowestPosition", "highestPosition", "randomNotes", "randomCards",
  ]).optional().describe("How Anki gathers new cards before applying their display sort."),
  newSortOrder: z.enum([
    "template", "none", "templateThenRandom", "randomNoteThenTemplate", "randomCard",
  ]).optional().describe("How gathered new cards are shown; none preserves the gather order."),
  newMix: reviewMix.optional().describe("When to show new cards relative to review cards."),
  dayLearningMix: reviewMix.optional().describe("When to show learning or relearning cards that crossed a study day, relative to review cards."),
  reviewOrder: z.enum([
    "day", "dayThenDeck", "deckThenDay", "intervalAscending", "intervalDescending", "easeAscending", "easeDescending",
    "retrievabilityAscending", "retrievabilityDescending", "relativeOverdueness", "random", "added", "reverseAdded",
  ]).optional().describe("Review card sort order. Some orders depend on Anki's active scheduler; this does not enable FSRS."),
  disableAutoplay: z.boolean().optional().describe("Do not automatically play card audio; manual playback remains available."),
  skipQuestionOnAnswerReplay: z.boolean().optional().describe("Skip question-side audio when manually replaying audio from the answer."),
  waitForAudio: z.boolean().optional().describe("Wait for audio to finish when Auto Advance is in use; does not enable Auto Advance."),
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
