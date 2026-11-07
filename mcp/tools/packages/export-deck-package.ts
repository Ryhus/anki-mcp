import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { deckNameKey, listManagedDecks } from "../../../anki-api/decks/deck-management-client.js";
import {
  exportPackageMethod, finishDeckPackageExport, requireLocalPackageEndpoint, startDeckPackageExport,
} from "../../../anki-api/packages/package-client.js";
import { openV1Adapter } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckIdSchema } from "../decks/shared-schemas.js";
import { createExportDestination, inspectPackageFile, isDeckPackageName, resolvePackageDirectory } from "./package-files.js";
import { packageApplyBlockers, packageFileSchema, packageHashSchema, packagePreviewInput } from "./shared-schemas.js";

const maxReviewedDecks = 100;
const fileNameSchema = z.string().regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._-]{0,114}\.apkg$/iu)
  .refine((name) => isDeckPackageName(name) && Buffer.byteLength(name, "utf8") <= 200 &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\b/iu.test(name), "Use a portable .apkg file name, not a path or collection backup name.");
const inputSchema = z.strictObject({
  deckId: deckIdSchema.describe("ID of one normal deck from list-decks; its subdecks are in scope."),
  fileName: fileNameSchema.optional().describe("File name only. Defaults to deck-<id>.apkg."),
  includeScheduling: z.boolean().default(false).describe("Include learning progress and review history."),
  ...packagePreviewInput,
  confirmExport: z.boolean().default(false),
});
const deckSummary = z.object({ id: deckIdSchema, name: z.string() });

export const exportDeckPackageConfig = {
  title: "Export Anki deck package",
  description: "Previews a local .apkg export of one normal deck and its subdecks. Media is included; scheduling is opt-in. On confirmation, writes a new file under the configured export directory without overwriting existing files. Requires local AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    dryRun: z.boolean(), exported: z.boolean(), impactHash: packageHashSchema.nullable(), profile: z.string().nullable(),
    deck: deckSummary, includedDecks: z.array(deckSummary).max(maxReviewedDecks),
    includedDeckCount: z.number().int().positive(),
    exportDirectory: z.string(), fileName: z.string(), includeScheduling: z.boolean(),
    includesMedia: z.literal(true), includesDeckPresets: z.literal(false),
    package: packageFileSchema.nullable(), blockers: z.array(z.string()), warnings: z.array(z.string()),
  }),
  annotations: NON_IDEMPOTENT_ADDITIVE_TOOL_ANNOTATIONS,
};

export async function exportDeckPackage(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  requireLocalPackageEndpoint(exportPackageMethod);
  const exportDirectory = await resolvePackageDirectory("ANKI_PACKAGE_EXPORT_DIR");
  const ctx = await openV1Adapter({});
  const decks = await listManagedDecks(ctx);
  const selected = decks.find(({ id }) => id === input.deckId);
  if (selected === undefined) throw new Error("The selected deck was not found.");
  const prefix = `${deckNameKey(selected.name)}::`;
  const scope = decks.filter(({ id, name }) => id === selected.id || deckNameKey(name).startsWith(prefix))
    .sort((a, b) => a.id - b.id);
  const included = scope.map(({ id, name }) => ({ id, name }));
  const fileName = input.fileName ?? `deck-${selected.id}.apkg`;
  const hash = createHash("sha256").update(JSON.stringify([
    "export-deck-package", 1, ctx.session, included, exportDirectory, fileName, input.includeScheduling,
  ])).digest("hex");
  const blockers = packageApplyBlockers(input, hash, input.confirmExport, "confirmExport");
  if (scope.some(({ kind }) => kind !== "normal")) blockers.push("Export only normal decks without filtered subdecks.");
  if (scope.length > maxReviewedDecks) blockers.push(`The deck scope exceeds the ${maxReviewedDecks}-deck review limit.`);
  const result = {
    dryRun: input.dryRun, exported: false, impactHash: blockers.length === 0 ? hash : null, profile: ctx.profile ?? null,
    deck: { id: selected.id, name: selected.name }, includedDeckCount: scope.length,
    includedDecks: included.slice(0, maxReviewedDecks), exportDirectory, fileName,
    includeScheduling: input.includeScheduling, includesMedia: true, includesDeckPresets: false, package: null, blockers,
    warnings: [
      "Exports to a new private subdirectory. The package contains deck content and referenced media; do not share it without reviewing it.",
      "The preview identifies the deck scope and options, not a snapshot of all Notes or Cards. Anki exports the current contents on apply.",
    ],
  };
  if (input.dryRun || blockers.length > 0) return createToolResult(
    blockers.length > 0 ? "No package was exported; resolve the blockers." : "Dry run: reviewed the export. No file was created.",
    result,
  );

  const path = await createExportDestination(exportDirectory, fileName);
  try {
    const operationId = await startDeckPackageExport(ctx, selected.id, path, input.includeScheduling);
    const saved = await finishDeckPackageExport(ctx, operationId);
    if (!isAbsolute(saved.path) || resolve(saved.path) !== path) {
      throw new Error("Anki did not report the expected private export path.");
    }
    const file = await inspectPackageFile(path);
    return createToolResult("Exported the deck package and verified the local file.", {
      ...result, exported: true, package: { path, ...file },
    });
  } catch (error) {
    throw new Error(
      `Could not confirm export. A package may already exist or still be writing at "${path}". Inspect it before retrying. No retry was performed. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
}
