import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  finishDeckPackageImport, importPackageMethod, requireLocalPackageEndpoint, startDeckPackageImport,
} from "../../../anki-api/packages/package-client.js";
import { openV1Adapter } from "../../../anki-api/v1/anki-v1-adapter-utils.js";
import { NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import {
  cleanImportSnapshot, createImportSnapshotPath, inspectPackageFile, PACKAGE_IMPORT_MAX_BYTES,
  resolvePackageDirectory, resolvePackageImportPath,
} from "./package-files.js";
import { packageApplyBlockers, packageFileSchema, packageHashSchema, packagePreviewInput } from "./shared-schemas.js";

const inputSchema = z.strictObject({
  localPath: z.string().min(1).max(4_096).describe("Absolute path to a trusted .apkg inside ANKI_PACKAGE_IMPORT_DIR."),
  ...packagePreviewInput,
  confirmImport: z.boolean().default(false).describe("Accept the import, including possible updates and learning progress."),
});

export const importDeckPackageConfig = {
  title: "Import Anki deck package",
  description: "Previews a trusted local .apkg file and imports its reviewed bytes into the active Anki collection. Anki can update existing Notes and merge Note Types; it imports scheduling and deck presets when present. Preview does not calculate a collection diff. Requires local AnkiConnect v1.",
  inputSchema,
  outputSchema: z.object({
    dryRun: z.boolean(), imported: z.boolean(), impactHash: packageHashSchema.nullable(), profile: z.string().nullable(),
    package: packageFileSchema, blockers: z.array(z.string()), warnings: z.array(z.string()),
  }),
  annotations: NON_IDEMPOTENT_DESTRUCTIVE_TOOL_ANNOTATIONS,
};

export async function importDeckPackage(input: z.infer<typeof inputSchema>): Promise<CallToolResult> {
  requireLocalPackageEndpoint(importPackageMethod);
  const root = await resolvePackageDirectory("ANKI_PACKAGE_IMPORT_DIR");
  const path = await resolvePackageImportPath(root, input.localPath);
  const file = await inspectPackageFile(path, PACKAGE_IMPORT_MAX_BYTES);
  const ctx = await openV1Adapter({});
  const hash = createHash("sha256").update(JSON.stringify([
    "import-deck-package", 1, ctx.session, path, file.byteSize, file.sha256,
  ])).digest("hex");
  const blockers = packageApplyBlockers(input, hash, input.confirmImport, "confirmImport");
  const warnings = [
    "Import only trusted deck packages, not renamed collection backups. Preview checks a ZIP header and file fingerprint, not the contents or the exact changes Anki will make.",
    "Anki may update existing Notes and merge Note Types. It imports learning progress and deck presets when present. This tool cannot disable those options.",
    "The hash binds the file and collection session, not collection contents. This tool does not create an Anki backup or automatically undo changes.",
  ];
  const result = {
    dryRun: input.dryRun, imported: false, impactHash: blockers.length === 0 ? hash : null, profile: ctx.profile ?? null,
    package: { path, ...file }, blockers, warnings,
  };
  if (input.dryRun || blockers.length > 0) return createToolResult(
    blockers.length > 0 ? "No package was imported; resolve the blockers." : "Dry run: verified the file fingerprint. Anki was not changed.",
    result,
  );

  const snapshot = await createImportSnapshotPath();
  try {
    const staged = await inspectPackageFile(path, PACKAGE_IMPORT_MAX_BYTES, snapshot);
    if (staged.byteSize !== file.byteSize || staged.sha256 !== file.sha256) {
      throw new Error("The source file no longer matches the reviewed fingerprint.");
    }
  } catch (error) {
    const cleaned = await cleanImportSnapshot(snapshot);
    throw new Error(
      `Import was not sent. Preview the source file again.${cleaned ? "" : ` A temporary copy may remain at "${snapshot}".`} ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }

  try {
    const operationId = await startDeckPackageImport(ctx, snapshot);
    await finishDeckPackageImport(ctx, operationId);
  } catch (error) {
    throw new Error(
      `Could not confirm import. Anki may already have changed or still be working. No retry or rollback was performed. The private copy is retained at "${snapshot}"; inspect Anki before retrying. ${error instanceof Error ? error.message : "Unknown failure."}`,
      { cause: error },
    );
  }
  if (!await cleanImportSnapshot(snapshot)) warnings.push(`A temporary copy may remain at "${snapshot}".`);
  return createToolResult("Anki confirmed completion of the package import. No per-Note change report is available.", {
    ...result, imported: true,
  });
}
