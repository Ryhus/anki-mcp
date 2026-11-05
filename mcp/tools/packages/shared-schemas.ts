import { z } from "zod";

export const packageHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const packageFileSchema = z.object({
  path: z.string(),
  byteSize: z.number().int().positive(),
  sha256: packageHashSchema,
});

export const packagePreviewInput = {
  dryRun: z.boolean().default(true).describe("Preview without exporting a file or importing into Anki."),
  expectedImpactHash: packageHashSchema.optional().describe("Hash from the reviewed preview."),
};

export function packageApplyBlockers(
  input: { dryRun: boolean; expectedImpactHash?: string | undefined }, hash: string, confirmed: boolean, confirmKey: string,
): string[] {
  const blockers: string[] = [];
  if (input.expectedImpactHash !== undefined && input.expectedImpactHash !== hash) {
    blockers.push("The reviewed package proposal or collection session changed. Preview again.");
  }
  if (!input.dryRun && (!confirmed || input.expectedImpactHash === undefined)) {
    blockers.push(`Applying requires ${confirmKey}: true and the reviewed expectedImpactHash.`);
  }
  return blockers;
}
