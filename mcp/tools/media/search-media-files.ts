import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAnkiMediaFileNames } from "../../../anki-api/media/media-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { inferMediaFileSummary } from "./media-utils.js";
import {
  MEDIA_SEARCH_LIMIT,
  mediaFileSummarySchema,
  mediaSearchPatternSchema,
} from "./shared-schemas.js";

const searchMediaFilesInputSchema = z.object({
  pattern: mediaSearchPatternSchema.describe(
    'AnkiConnect glob pattern such as "*.mp3", "_logo*", or "gehen*"',
  ),
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MEDIA_SEARCH_LIMIT)
    .default(20),
});

type SearchMediaFilesInput = z.infer<
  typeof searchMediaFilesInputSchema
>;

export const searchMediaFilesConfig = {
  title: "Search media files",
  description:
    "Returns a bounded, sorted page of filenames from Anki's current collection.media folder.",
  inputSchema: searchMediaFilesInputSchema,
  outputSchema: z.object({
    pattern: z.string(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    files: z.array(mediaFileSummarySchema),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Lists media without retrieving large file contents into MCP context. */
export async function searchMediaFiles({
  pattern,
  offset,
  limit,
}: SearchMediaFilesInput): Promise<CallToolResult> {
  const filenames = await getAnkiMediaFileNames(pattern);
  const sortedFilenames = [...filenames].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
  const page = sortedFilenames.slice(offset, offset + limit);
  const files = page.map((filename) => ({
    filename,
    ...inferMediaFileSummary(filename),
  }));
  const hasMore = offset + page.length < sortedFilenames.length;

  return createToolResult(
    `Found ${sortedFilenames.length} media file${sortedFilenames.length === 1 ? "" : "s"} matching "${pattern}"; returned ${files.length} from offset ${offset}${hasMore ? " with more results available" : ""}.`,
    {
      pattern,
      total: sortedFilenames.length,
      offset,
      returned: files.length,
      hasMore,
      files,
    },
  );
}
