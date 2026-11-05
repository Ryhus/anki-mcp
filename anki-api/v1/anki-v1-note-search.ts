import { openV1Adapter, searchV1IdPage } from "./anki-v1-adapter-utils.js";
import { getV1Notes } from "./anki-v1-note-client.js";

/** Loads only one native search page and its details, pinned to one collection. */
export async function getV1NoteSearchPage(query: string, limit: number, cursor?: string) {
  const ctx = await openV1Adapter({});
  const { ids, nextCursor } = await searchV1IdPage(ctx, "notes.search", query, limit, cursor);
  return { ...await getV1Notes(ids, ctx.session), nextCursor };
}
