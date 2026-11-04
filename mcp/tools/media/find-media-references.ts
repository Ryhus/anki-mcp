import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { findMediaUsage } from "./media-usage-utils.js";
import {
  mediaFilenameSchema,
  mediaUsageSchema,
} from "./shared-schemas.js";

const findMediaReferencesInputSchema = z.object({
  filename: mediaFilenameSchema,
});

type FindMediaReferencesInput = z.infer<
  typeof findMediaReferencesInputSchema
>;

export const findMediaReferencesConfig = {
  title: "Find media references",
  description:
    "Scans note fields, Card Template HTML, and note-type CSS for exact references to one Anki media filename. Complete scans return a fingerprint for safe deletion. CSS parsing failures are reported separately and make counts incomplete; no fingerprint is issued.",
  inputSchema: findMediaReferencesInputSchema,
  outputSchema: z.object({
    usage: mediaUsageSchema,
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Reports reference impact separately from destructive deletion. */
export async function findMediaReferences({
  filename,
}: FindMediaReferencesInput): Promise<CallToolResult> {
  const usage = await findMediaUsage(filename);
  const incompleteReasons: string[] = [];
  if (usage.scannedNoteCount < usage.candidateNoteCount) {
    incompleteReasons.push("some candidate notes exceeded the safety limit or could not be loaded");
  }
  if (usage.cssScanFailureCount > 0) {
    incompleteReasons.push(`CSS could not be fully inspected for ${usage.cssScanFailureCount} note type${usage.cssScanFailureCount === 1 ? "" : "s"}; see usage.cssScanFailures`);
  }
  const scanDescription =
    usage.scanStrategy === "native-candidates"
      ? `exactly inspected ${usage.scannedNoteCount} native-search candidate note${usage.scannedNoteCount === 1 ? "" : "s"} out of ${usage.totalNoteCount} total`
      : `exactly inspected ${usage.scannedNoteCount} note${usage.scannedNoteCount === 1 ? "" : "s"} out of ${usage.totalNoteCount} total after native search fell back`;

  return createToolResult(
    `Found ${usage.scanComplete ? "" : "at least "}${usage.totalReferenceCount} reference${usage.totalReferenceCount === 1 ? "" : "s"} to "${filename}"; ${scanDescription} and scanned ${usage.scannedNoteTypeCount} note type${usage.scannedNoteTypeCount === 1 ? "" : "s"}${usage.scanComplete ? "." : `; the reference scan was incomplete: ${incompleteReasons.join("; ")}. Counts may omit references.`}`,
    { usage },
  );
}
