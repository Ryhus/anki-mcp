import { z } from "zod";
import { useAnkiV1 } from "../../anki-api/anki-api-mode.js";
import { AnkiRequestError } from "../../anki-api/anki-request-error.js";

export const searchPaginationShape = {
  pagination: z.enum(["offset", "cursor"]).optional()
    .describe("Defaults to cursor when v1 is enabled and no offset is supplied. Use offset for an exact total or a numeric position."),
  cursor: z.string().min(1).max(4_096).optional()
    .describe("Use the previous nextCursor with the same query and limit. Omit it on the first cursor page."),
  offset: z.number().int().nonnegative().optional()
    .describe("Supplying an offset, even 0, selects offset mode unless pagination is explicit."),
};

type Pagination = z.infer<z.ZodObject<typeof searchPaginationShape>>;

export function validateSearchPagination({ pagination, cursor, offset }: Pagination, context: z.RefinementCtx): void {
  if (cursor !== undefined && (pagination === "offset" || (pagination === undefined && offset !== undefined))) {
    context.addIssue({ code: "custom", path: ["cursor"], message: "Cannot combine a continuation cursor with offset pagination" });
  }
  if (pagination === "cursor" && (offset ?? 0) !== 0) {
    context.addIssue({ code: "custom", path: ["offset"], message: "Cursor pagination does not accept a nonzero offset" });
  }
}

export function resolveSearchPagination(
  { pagination, cursor, offset }: Pagination, method: "notes.search" | "cards.search",
): "offset" | "cursor" {
  const v1 = useAnkiV1(method);
  const mode = pagination ?? (cursor !== undefined || (v1 && offset === undefined) ? "cursor" : "offset");
  if (mode === "cursor" && !v1) {
    throw new AnkiRequestError("configuration", method, "Cursor pagination requires ANKI_API_MODE=v1.", false);
  }
  return mode;
}
