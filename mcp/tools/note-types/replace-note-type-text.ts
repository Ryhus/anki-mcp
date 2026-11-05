import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  openNoteTypeManagement, replaceManagedNoteTypeText, replaceNoteTypeTextMethod,
} from "../../../anki-api/note-types/note-type-management-client.js";
import { getV1NoteTypeDesign } from "../../../anki-api/v1/anki-v1-collection-client.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { createDesignValidation } from "./design-validation.js";
import { normalizeV1NoteTypeDesign, NOTE_TYPE_SCOPE_WARNING } from "./note-type-design-utils.js";
import { noteTypeTextTargetSchema, planNoteTypeTextReplacement, replacementPlanSchema } from "./note-type-text-replacement.js";
import { designValidationSchema, noteTypeIdSchema } from "./shared-schemas.js";

const maxTypes = 20;
const maxTemplates = 100;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.strictObject({
  noteTypeIds: z.array(noteTypeIdSchema).min(1).max(maxTypes)
    .refine((ids) => new Set(ids).size === ids.length, "Use unique Note Type IDs.")
    .describe(`Explicit selection of up to ${maxTypes} Note Type IDs from list-note-types.`),
  targets: z.array(noteTypeTextTargetSchema).min(1).max(3)
    .refine((targets) => new Set(targets).size === targets.length, "Use each target only once.")
    .describe("Choose question (front HTML), answer (back HTML), and/or css."),
  find: z.string().min(1).max(2_000).refine((text) => text.isWellFormed()).describe("Literal case-sensitive search text, not a regular expression."),
  replace: z.string().max(4_000).refine((text) => text.isWellFormed()).describe("Literal replacement text. An empty string removes the matches."),
  dryRun: z.boolean().default(true).describe("Preview without changing Anki."),
  expectedImpactHash: hashSchema.optional().describe("Hash from the reviewed replacement preview."),
  confirmReplacement: z.boolean().default(false),
}).refine(({ find, replace }) => find !== replace, { path: ["replace"], message: "Replacement must differ from search text." });

export const replaceNoteTypeTextConfig = {
  title: "Replace literal text in Anki note type designs",
  description: "Previews and validates a case-sensitive literal replacement in explicitly selected Note Types' front HTML, back HTML, and/or CSS. Does not replace Note field values. Applying requires AnkiConnect v1, a current impact hash, and explicit confirmation.",
  inputSchema,
  outputSchema: z.object({
    profile: z.string().nullable(), dryRun: z.boolean(), applied: z.boolean(), verified: z.boolean(),
    impactHash: hashSchema.nullable(), changes: z.array(replacementPlanSchema).max(maxTypes),
    occurrenceCount: z.number().int().nonnegative(), changedTypeCount: z.number().int().nonnegative(),
    validation: designValidationSchema, blockers: z.array(z.string()), warnings: z.array(z.string()),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function replaceNoteTypeText({
  noteTypeIds, targets, find, replace, dryRun, expectedImpactHash, confirmReplacement,
}: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  const ctx = await openNoteTypeManagement(replaceNoteTypeTextMethod);
  const ids = [...noteTypeIds].sort((a, b) => a - b);
  const orderedTargets = [...targets].sort();
  const loadDesign = async (id: number) => normalizeV1NoteTypeDesign(await getV1NoteTypeDesign(id, ctx.session, ctx.options));
  const current = await Promise.all(ids.map(loadDesign));
  if (current.reduce((sum, { templates }) => sum + templates.length, 0) > maxTemplates) {
    throw new Error(`Select fewer Note Types: the replacement review limit is ${maxTemplates} templates.`);
  }
  const changes = current.map((design) => planNoteTypeTextReplacement(design, find, replace, orderedTargets));
  const validation = createDesignValidation(changes.flatMap(({ issues }) => issues));
  const changed = changes.filter(({ matches }) => matches.length > 0);
  const hash = createHash("sha256").update(JSON.stringify([
    "replace-note-type-text", 1, ctx.session, orderedTargets, find, replace,
    current.map(({ noteType, designHash }) => [noteType, designHash]),
  ])).digest("hex");
  const blockers: string[] = [];
  if (!validation.valid) blockers.push("A proposed design is invalid. No replacement will be sent.");
  if (expectedImpactHash !== undefined && expectedImpactHash !== hash) {
    blockers.push("The reviewed text, targets, Note Types, or collection session changed. Preview again.");
  }
  if (!dryRun && (!confirmReplacement || expectedImpactHash === undefined)) {
    blockers.push("Applying requires confirmReplacement: true and the reviewed expectedImpactHash.");
  }
  const result = {
    profile: ctx.profile ?? null, dryRun, applied: false, verified: false,
    impactHash: blockers.length === 0 ? hash : null, blockers,
    changes: changes.map(({ issues: _issues, ...plan }) => plan),
    occurrenceCount: changed.reduce((sum, { matches }) => sum + matches.reduce((n, match) => n + match.occurrences, 0), 0),
    changedTypeCount: changed.length,
    validation,
    warnings: [
      NOTE_TYPE_SCOPE_WARNING,
      "The preflight and write are not atomic. Anki can fail after changing some of the selected Note Types.",
    ],
  };
  if (blockers.length > 0) return createToolResult("No design changes were sent; resolve the replacement blockers.", result);
  if (dryRun) return createToolResult(`Dry run: ${result.occurrenceCount} match(es) in ${changed.length} Note Type(s). Anki was not changed.`, result);
  if (changed.length === 0) return createToolResult("No matching text to replace.", { ...result, verified: true });

  try {
    await replaceManagedNoteTypeText(ctx, changed.map(({ noteType }) => noteType.id), find, replace, orderedTargets);
    const saved = await Promise.all(changed.map(({ noteType }) => loadDesign(noteType.id)));
    if (saved.some(({ noteType, designHash }, index) =>
      designHash !== changed[index]!.afterHash ||
      JSON.stringify(noteType) !== JSON.stringify(current.find(({ noteType: original }) => original.id === noteType.id)?.noteType)
    )) throw new Error("Readback did not confirm the proposed designs and unchanged Note Type definitions.");
  } catch (error) {
    throw new Error(
      `Could not confirm text replacement. Some designs may already have changed; inspect Anki before retrying. No retry or rollback was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  return createToolResult(`Replaced text and verified ${changed.length} changed Note Type(s).`, {
    ...result, applied: true, verified: true,
  });
}
