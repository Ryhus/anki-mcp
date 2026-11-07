import { z } from "zod";
import type { AnkiRequestOptions } from "../anki-request-config.js";
import type { AnkiNoteFieldUpdate } from "../notes/note-types.js";
import { stringIds, type V1AdapterContext } from "./anki-v1-adapter-utils.js";
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
export type V1Note = z.infer<typeof noteSchema>;
const noteBatchSchema = z.object({
  items: z.array(z.union([
    z.strictObject({ index: z.number().int().nonnegative(), result: noteSchema }),
    z.strictObject({ index: z.number().int().nonnegative(), error: ankiV1ErrorSchema }),
  ])),
});

/** Loads notes in input order, distinguishing missing notes from other failures. */
export async function getV1Notes(ids: readonly number[], session: string, options?: AnkiRequestOptions) {
  const notes: V1Note[] = [];
  const missingNoteIds: number[] = [];
  if (ids.length === 0) return { notes, missingNoteIds };

  const method = "notes.getMany";
  const { items } = await callAnkiV1(method, { ids: ids.map(String), session }, noteBatchSchema, options);
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
  return { notes, missingNoteIds };
}

/** Updates only the supplied fields and validates the acknowledgement's identity. */
export async function updateV1NoteFields(note: AnkiNoteFieldUpdate, session: string, options?: AnkiRequestOptions): Promise<void> {
  const method = "notes.update";
  const updated = await callAnkiV1(method, {
    id: String(note.id), patch: { fields: note.fields }, session,
  }, noteSchema, options);
  if (updated.id !== note.id) throw invalidAnkiV1Response(method);
}

/** Replaces a single tag only on the explicitly reviewed Notes. */
export async function replaceV1NoteTag(ctx: V1AdapterContext, noteIds: readonly number[], from: string, to: string): Promise<void> {
  if (noteIds.length === 0) return;
  const method = "tags.replace";
  const { changedCount } = await ctx.request(method, { noteIds: stringIds(noteIds), from, to },
    z.object({ changedCount: z.number().int().nonnegative() }));
  if (changedCount !== noteIds.length) throw invalidAnkiV1Response(method);
}
