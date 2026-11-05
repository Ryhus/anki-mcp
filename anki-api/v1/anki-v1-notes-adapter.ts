import type { AnkiNoteFieldUpdate, AnkiNoteInfo } from "../notes/note-types.js";
import { getV1NoteTypeDesign } from "./anki-v1-collection-client.js";
import { getV1Notes, updateV1NoteFields } from "./anki-v1-note-client.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";
import { readV1Acks, searchAllV1Ids, stringIds, type V1AdapterContext, type V1Route } from "./anki-v1-adapter-utils.js";

// An adapter context is shared only inside one read group, not across writes.
const readDesigns = new WeakMap<V1AdapterContext, Map<number, ReturnType<typeof getV1NoteTypeDesign>>>();

/** Reconstructs ordered fields from the Note Type, not JSON object key order. */
export async function loadV1NoteInfo(ctx: V1AdapterContext, ids: readonly number[]): Promise<Map<number, AnkiNoteInfo>> {
  const { notes } = await getV1Notes([...new Set(ids)], ctx.session, ctx.options);
  let designs = readDesigns.get(ctx);
  if (designs === undefined) {
    designs = new Map();
    readDesigns.set(ctx, designs);
  }
  const cached = designs;
  await Promise.all(notes.map(async ({ noteType }) => {
    let design = cached.get(noteType.id);
    if (!design) {
      design = getV1NoteTypeDesign(noteType.name, ctx.session, ctx.options);
      cached.set(noteType.id, design);
    }
    const saved = await design;
    if (saved.id !== noteType.id || saved.name !== noteType.name) throw invalidAnkiV1Response("noteTypes.get");
  }));
  const entries = await Promise.all(notes.map(async (note) => {
    const { fields } = await cached.get(note.noteType.id)!;
    if (fields.length !== Object.keys(note.fields).length || fields.some(({ name }) => !Object.hasOwn(note.fields, name))) {
      throw invalidAnkiV1Response("notes.getMany");
    }
    const info: AnkiNoteInfo = {
      noteId: note.id, modelName: note.noteType.name,
      ...(ctx.profile === undefined ? {} : { profile: ctx.profile }),
      tags: note.tags, cards: note.cardIds, mod: Math.floor(Date.parse(note.modifiedAt) / 1_000),
      fields: Object.fromEntries(fields.map(({ name }, order) => [name, { value: note.fields[name]!, order }])),
    };
    return [note.id, info] as const;
  }));
  return new Map(entries);
}

function tagRoute(method: "tags.add" | "tags.remove"): V1Route {
  return async ({ notes, tags }, ctx) => {
    const noteIds = stringIds(notes as number[]);
    await readV1Acks(ctx, method, { noteIds, tags: (tags as string).split(/\s+/u) }, noteIds.length);
    return null;
  };
}

export const v1NotesRoutes = {
  async getActiveProfile(_params, ctx) {
    if (ctx.profile === undefined) throw invalidAnkiV1Response("collection.get");
    return ctx.profile;
  },
  findNotes: ({ query }, ctx) => searchAllV1Ids(ctx, "notes.search", query as string),
  async notesInfo({ notes }, ctx) {
    const ids = notes as number[];
    const loaded = await loadV1NoteInfo(ctx, ids);
    return ids.map((id) => loaded.get(id) ?? {});
  },
  async updateNoteFields({ note }, ctx) {
    await updateV1NoteFields(note as AnkiNoteFieldUpdate, ctx.session, ctx.options);
    return null;
  },
  addTags: tagRoute("tags.add"),
  removeTags: tagRoute("tags.remove"),
  async deleteNotes({ notes }, ctx) {
    const ids = stringIds(notes as number[]);
    const changes = await readV1Acks(ctx, "notes.delete", { ids }, ids.length);
    if (changes.some((changed) => !changed)) throw invalidAnkiV1Response("notes.delete");
    return null;
  },
} satisfies Record<string, V1Route>;
