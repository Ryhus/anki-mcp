import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    "Scans note fields, Card Template HTML, and note-type CSS for exact references to one Anki media filename.",
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
  const scanDescription =
    usage.scanStrategy === "native-candidates"
      ? `exactly inspected ${usage.scannedNoteCount} native-search candidate note${usage.scannedNoteCount === 1 ? "" : "s"} out of ${usage.totalNoteCount} total`
      : `exactly inspected ${usage.scannedNoteCount} note${usage.scannedNoteCount === 1 ? "" : "s"} out of ${usage.totalNoteCount} total after native search fell back`;

  return createToolResult(
    `Found ${usage.totalReferenceCount} reference${usage.totalReferenceCount === 1 ? "" : "s"} to "${filename}"; ${scanDescription} and scanned ${usage.scannedNoteTypeCount} note type${usage.scannedNoteTypeCount === 1 ? "" : "s"}${usage.scanComplete ? "." : "; the candidate scan was incomplete because it exceeds the safety limit."}`,
    { usage },
  );
}
