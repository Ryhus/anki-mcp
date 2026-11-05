import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { AnkiRequestError } from "../anki-request-error.js";
import { openV1Adapter, readV1IdPage, searchV1IdPage } from "./anki-v1-adapter-utils.js";
import { getV1Notes } from "./anki-v1-note-client.js";

/** Loads only one native search page and its details, pinned to one collection. */
export async function getV1NoteSearchPage(query: string, limit: number, cursor?: string) {
  const ctx = await openV1Adapter({});
  const { ids, nextCursor } = await searchV1IdPage(ctx, "notes.search", query, limit, cursor);
  return { ...await getV1Notes(ids, ctx.session), nextCursor };
}

export const emptyNoteCriterionSchema = z.enum(["allFieldsEmpty", "noCards", "allQuestionsEmpty"]);
type EmptyNoteCriterion = z.infer<typeof emptyNoteCriterionSchema>;

/** Uses Anki's native criteria, never the legacy removeEmptyNotes action. */
export async function findV1EmptyNotesPage(criterion: EmptyNoteCriterion, query: string, limit: number, cursor?: string) {
  const method = "notes.findEmpty";
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "Finding empty Notes requires ANKI_API_MODE=v1.", false);
  }
  const ctx = await openV1Adapter({});
  const { ids, nextCursor } = await readV1IdPage(ctx, method, {
    criterion, query, ...(cursor === undefined ? {} : { cursor }),
  }, limit);
  return { ...await getV1Notes(ids, ctx.session), nextCursor };
}
