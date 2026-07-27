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

  return createToolResult(
    `Found ${usage.totalReferenceCount} reference${usage.totalReferenceCount === 1 ? "" : "s"} to "${filename}" across ${usage.scannedNoteCount} note${usage.scannedNoteCount === 1 ? "" : "s"} and ${usage.scannedNoteTypeCount} note type${usage.scannedNoteTypeCount === 1 ? "" : "s"}${usage.scanComplete ? "." : "; the note scan was incomplete because the collection exceeds the safety limit."}`,
    { usage },
  );
}
