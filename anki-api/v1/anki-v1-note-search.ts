import { z } from "zod";
import { v1EntityIdSchema, v1EntitySummarySchema } from "./anki-v1-collection-client.js";
import {
  AnkiV1Error,
  ankiV1ErrorSchema,
  callAnkiV1,
  invalidAnkiV1Response,
} from "./anki-v1-request.js";

const noteSchema = z.object({
  id: v1EntityIdSchema,
  noteType: v1EntitySummarySchema,
  fields: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  cardIds: z.array(v1EntityIdSchema),
  modifiedAt: z.iso.datetime(),
});
const searchPageSchema = z.object({
  ids: z.array(v1EntityIdSchema),
  nextCursor: z.string().min(1).nullable(),
});
const noteBatchSchema = z.object({
  items: z.array(z.union([
    z.strictObject({ index: z.number().int().nonnegative(), result: noteSchema }),
    z.strictObject({ index: z.number().int().nonnegative(), error: ankiV1ErrorSchema }),
  ])),
});
const sessionSchema = z.object({ session: z.string().min(1) });

/** Loads only one native search page and its details, pinned to one collection. */
export async function getV1NoteSearchPage(query: string, limit: number, cursor?: string) {
  const { session } = await callAnkiV1("collection.get", {}, sessionSchema);
  const { ids, nextCursor } = await callAnkiV1(
    "notes.search", { query, limit, session, ...(cursor === undefined ? {} : { cursor }) }, searchPageSchema,
  );
  if (ids.length > limit || new Set(ids).size !== ids.length) {
    throw invalidAnkiV1Response("notes.search");
  }
  const notes: z.infer<typeof noteSchema>[] = [];
  const missingNoteIds: number[] = [];
  if (ids.length === 0) return { notes, missingNoteIds, nextCursor };

  const method = "notes.getMany";
  const { items } = await callAnkiV1(method, { ids: ids.map(String), session }, noteBatchSchema);
  if (items.length !== ids.length) throw invalidAnkiV1Response(method);
  for (const [index, item] of items.entries()) {
    const id = ids[index]!;
    if (item.index !== index) throw invalidAnkiV1Response(method);
    if ("error" in item) {
      if (item.error.code !== 1001) throw new AnkiV1Error(method, item.error.code);
      missingNoteIds.push(id);
    } else {
      if (item.result.id !== id) throw invalidAnkiV1Response(method);
      notes.push(item.result);
    }
  }
  return { notes, missingNoteIds, nextCursor };
}
