import { z } from "zod";
import { getV1CollectionSession, v1EntityIdSchema } from "./anki-v1-collection-client.js";
import { getV1Notes } from "./anki-v1-note-client.js";
import { callAnkiV1, invalidAnkiV1Response } from "./anki-v1-request.js";

const searchPageSchema = z.object({
  ids: z.array(v1EntityIdSchema),
  nextCursor: z.string().min(1).nullable(),
});

/** Loads only one native search page and its details, pinned to one collection. */
export async function getV1NoteSearchPage(query: string, limit: number, cursor?: string) {
  const session = await getV1CollectionSession();
  const { ids, nextCursor } = await callAnkiV1(
    "notes.search", { query, limit, session, ...(cursor === undefined ? {} : { cursor }) }, searchPageSchema,
  );
  if (ids.length > limit || new Set(ids).size !== ids.length) {
    throw invalidAnkiV1Response("notes.search");
  }
  return { ...await getV1Notes(ids, session), nextCursor };
}
