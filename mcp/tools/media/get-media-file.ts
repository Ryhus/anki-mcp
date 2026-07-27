import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadAnkiMediaFile } from "./media-loader.js";
import {
  MEDIA_CONTENT_PREVIEW_LIMIT,
  mediaFileDescriptorSchema,
  mediaFilenameSchema,
} from "./shared-schemas.js";

const getMediaFileInputSchema = z.object({
  filename: mediaFilenameSchema,
  includeContent: z
    .boolean()
    .default(false)
    .describe(
      "Return supported image or audio bytes as a native MCP content block when the file is small enough",
    ),
});

type GetMediaFileInput = z.infer<typeof getMediaFileInputSchema>;

export const getMediaFileConfig = {
  title: "Get media file",
  description:
    "Returns verified metadata for one exact Anki media file and can include a bounded image or audio preview.",
  inputSchema: getMediaFileInputSchema,
  outputSchema: z.object({
    exists: z.boolean(),
    file: mediaFileDescriptorSchema.nullable(),
    contentIncluded: z.boolean(),
    contentOmissionReason: z.string().nullable(),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Retrieves exact bytes while keeping base64 out of structured metadata. */
export async function getMediaFile({
  filename,
  includeContent,
}: GetMediaFileInput): Promise<CallToolResult> {
  const loaded = await loadAnkiMediaFile(filename);

  if (loaded === null) {
    return createToolResult(`Media file "${filename}" was not found.`, {
      exists: false,
      file: null,
      contentIncluded: false,
      contentOmissionReason: "File not found",
    });
  }

  const canInclude =
    includeContent &&
    loaded.descriptor.byteLength <= MEDIA_CONTENT_PREVIEW_LIMIT &&
    (loaded.descriptor.kind === "image" ||
      loaded.descriptor.kind === "audio");
  const contentOmissionReason = createContentOmissionReason(
    includeContent,
    loaded.descriptor.kind,
    loaded.descriptor.byteLength,
  );
  const result = createToolResult(
    `Retrieved metadata for "${filename}" (${loaded.descriptor.kind}, ${loaded.descriptor.byteLength} bytes)${canInclude ? " with native MCP content." : "."}`,
    {
      exists: true,
      file: loaded.descriptor,
      contentIncluded: canInclude,
      contentOmissionReason,
    },
  );

  if (canInclude && loaded.descriptor.kind === "image") {
    result.content.push({
      type: "image",
      data: loaded.data,
      mimeType: loaded.descriptor.mimeType,
    });
  } else if (canInclude && loaded.descriptor.kind === "audio") {
    result.content.push({
      type: "audio",
      data: loaded.data,
      mimeType: loaded.descriptor.mimeType,
    });
  }

  return result;
}

function createContentOmissionReason(
  includeContent: boolean,
  kind: string,
  byteLength: number,
): string | null {
  if (!includeContent) {
    return "Content was not requested";
  }
  if (byteLength > MEDIA_CONTENT_PREVIEW_LIMIT) {
    return `File exceeds the ${MEDIA_CONTENT_PREVIEW_LIMIT} byte preview limit`;
  }
  if (kind !== "image" && kind !== "audio") {
    return "Native MCP preview is available only for images and audio";
  }

  return null;
}
