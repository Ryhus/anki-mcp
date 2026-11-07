import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAnkiTags } from "../../../anki-api/notes/note-client.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { compareNames } from "./note-utils.js";

const listTagsInputSchema = z.object({
  prefix: z
    .string()
    .max(500)
    .default("")
    .describe("Optional case-insensitive tag prefix filter"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

type ListTagsInput = z.infer<typeof listTagsInputSchema>;

export const listTagsConfig = {
  title: "List tags",
  description:
    "Lists a bounded page of tags from the current Anki collection, optionally filtered by prefix.",
  inputSchema: listTagsInputSchema,
  outputSchema: z.object({
    prefix: z.string(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    tags: z.array(z.string()),
  }),
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Filters and paginates the collection tag registry for bounded MCP output. */
export async function listTags({
  prefix,
  offset,
  limit,
}: ListTagsInput): Promise<CallToolResult> {
  const normalizedPrefix = prefix.toLowerCase();
  const matchingTags = (await getAnkiTags())
    .filter((tag) =>
      tag.toLowerCase().startsWith(normalizedPrefix),
    )
    .sort(compareNames);
  const tags = matchingTags.slice(offset, offset + limit);
  const hasMore = offset + tags.length < matchingTags.length;

  return createToolResult(
    `Found ${matchingTags.length} matching tag${matchingTags.length === 1 ? "" : "s"}; returned ${tags.length} from offset ${offset}${hasMore ? " with more results available" : ""}.`,
    {
      prefix,
      total: matchingTags.length,
      offset,
      returned: tags.length,
      hasMore,
      tags,
    },
  );
}
